/**
 * @file src/lib/bot-pnl-updater.js
 * @module bot-pnl-updater
 * @description
 * P&L snapshot computation and position stats for the bot poll cycle.
 * Extracted from bot-loop.js to stay within the 500-line limit.
 *
 * All functions receive their dependencies as parameters — no module-level state.
 */

"use strict";

const { log } = require("./log");
const { ensureLiveEpoch } = require("./live-epoch-entry");
const config = require("./config");
const rangeMath = require("./range-math");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { fetchHistoricalTokenPriceUsd } = require("./historical-token-price");
const { applyPriceOverrides } = require("./price-overrides");
const { coinsToUsd, nftCoinsToUsd } = require("./coin-value");
const { hasCompoundedTotal } = require("./bot-config-keys");
const { _computeIL } = require("./bot-pnl-il");
const { pollDeposits } = require("./counted-deposits");
const { PM_ABI } = require("./pm-abi");
const {
  maybeNotifyBalanced,
} = require("./telegram-notifications/balanced-notifier");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { applyInitialResidual } = require("./bot-pnl-initial-residual");

/*-
 *  The shipped default, read once at load.  `readBotConfigDefaults()`
 *  merges the JSON from disk on every call and this resolves once per
 *  position per poll cycle, so reading it per call would put file I/O
 *  on the poll path.  Reading once is also the semantics the setting's
 *  group documents: override it in the user-configurable file and
 *  restart. The reader does not throw. The shipped file it starts from
 *  holds this setting, held to its range by
 *  `test/shipped-config-values.test.js`, and startup refuses an
 *  override outside that range.
 */
const _SHIPPED_BALANCED_MULTIPLIER =
  readBotConfigDefaults().pricePauseExceptionPollWindowMultiple;

/**
 * Resolve the balanced-notifier fetch-window multiplier.  Order of
 * precedence: explicit override in the merged cfg → the shipped
 * default read at load.
 */
function _resolveBalancedMultiplier(deps) {
  const gc = deps._getConfig;
  const explicit = gc && gc("pricePauseExceptionPollWindowMultiple");
  if (typeof explicit === "number" && explicit >= 1) return explicit;
  return _SHIPPED_BALANCED_MULTIPLIER;
}

const _ERC20_BAL_ABI = ["function balanceOf(address) view returns (uint256)"];
const _MAX_UINT128 = 2n ** 128n - 1n;

/** Convert a BigInt token amount to a float given its decimals. */
function toFloat(amount, decimals) {
  return Number(amount) / Math.pow(10, decimals);
}

/** Calculate the USD value of a V3 position from on-chain amounts. */
function positionValueUsd(p, ps, pr0, pr1) {
  const a = rangeMath.positionAmounts(
    p.liquidity || 0,
    ps.tick,
    p.tickLower,
    p.tickUpper,
    ps.decimals0,
    ps.decimals1,
  );
  const value = a.amount0 * pr0 + a.amount1 * pr1;
  /*-
   *  NaN here means a caller handed this something that is not a number,
   *  and it must not be allowed to leave: this figure is Current Value,
   *  and Net P&L, Profit and IL/G are all built on it, so a NaN spreads
   *  to every money reading at once and compares false against every
   *  threshold it meets on the way — including the Impermanent Loss
   *  Guard's.
   *
   *  Nothing upstream produces it. `fetchTokenPriceUsd` answers a number
   *  and falls back to zero on every failure path, so a missing price
   *  arrives as zero and values the position at zero. NaN can only come
   *  from a caller passing the wrong thing, which is a defect in this
   *  app rather than a condition in the world.
   *
   *  So it throws rather than substituting a default. A default cannot be
   *  right here except by luck — zero would report a funded position as
   *  worthless — and it would hide the one thing worth knowing.
   */
  if (!Number.isFinite(value))
    throw new Error(
      `positionValueUsd: non-finite result (${value}) from amounts ` +
        `${a.amount0}/${a.amount1} at prices ${pr0}/${pr1} — a caller ` +
        `passed something that is not a number`,
    );
  return value;
}

/**
 * The open period's NFT mint gas, in native coins, or 0.
 *
 * Every other charge the position ever paid is on a period: a closed
 * period carries its NFT's whole gas, read from chain and priced at that
 * period's close day, and the open one collects its compounds and
 * cancels as they happen. The one charge no period holds is the mint of
 * the NFT open right now — it was spent before that period began, and
 * only reaches a period when the period closes and is rebuilt from
 * chain. Without this the Lifetime Gas line omits it, while the Current
 * panel shows it, and a position that has never rebalanced reports no
 * gas at all.
 *
 * Read from the baseline's `mintGasWei`, which is that mint transaction
 * alone. Deliberately NOT `nftGasWeiByTokenId`, which is the mint PLUS
 * that NFT's compound gas — the open period already counts those
 * compounds, so using it would double them.
 *
 * Derived here rather than stored on the period. A stored copy would be
 * offered again on every poll and need a mark to stop it accumulating,
 * and that mark then freezes a figure the operator may need re-priced.
 *
 * @param {object} deps  Bot deps; `_botState.hodlBaseline` holds the mint.
 * @param {object} snap  Snapshot being completed; its live period decides
 *   whether a mint is outstanding at all.
 * @returns {number} Native coins, or 0 when there is no open period or no
 *   mint recorded.
 */
function _openNftMintGasNative(deps, snap) {
  if (snap?.liveEpoch === undefined || snap?.liveEpoch === null) return 0;
  const wei = deps?._botState?.hodlBaseline?.mintGasWei;
  if (typeof wei !== "string" || wei === "" || wei === "0") return 0;
  let native;
  try {
    native = Number(BigInt(wei)) / 1e18;
  } catch {
    return 0;
  }
  return Number.isFinite(native) && native > 0 ? native : 0;
}

/** Fetch USD prices for both tokens in a position. */
async function fetchTokenPrices(token0, token1) {
  const [price0, price1] = await Promise.all([
    fetchTokenPriceUsd(token0),
    fetchTokenPriceUsd(token1),
  ]);
  return { price0, price1 };
}

/** Read uncollected fees via static collect(MAX_UINT128) call. */
async function readUnclaimedFees(provider, ethersLib, tokenId, signer) {
  if (signer) {
    try {
      const pm = new ethersLib.Contract(
        config.POSITION_MANAGER,
        PM_ABI,
        signer,
      );
      const r = await pm.collect.staticCall({
        tokenId,
        recipient: await signer.getAddress(),
        amount0Max: _MAX_UINT128,
        amount1Max: _MAX_UINT128,
      });
      return { tokensOwed0: r.amount0, tokensOwed1: r.amount1 };
    } catch (e) {
      log.warn(
        "[bot] collect.staticCall failed for #%s: %s",
        String(tokenId),
        e.message,
      );
    }
  }
  try {
    const d = await new ethersLib.Contract(
      config.POSITION_MANAGER,
      PM_ABI,
      provider,
    ).positions(tokenId);
    return { tokensOwed0: d.tokensOwed0, tokensOwed1: d.tokensOwed1 };
  } catch {
    return { tokensOwed0: 0n, tokensOwed1: 0n };
  }
}

/** Compute per-token pool share percentages. */
async function addPoolShare(
  posStats,
  amounts,
  position,
  poolState,
  ethersLib,
  provider,
) {
  try {
    const [pool0, pool1] = await Promise.all([
      new ethersLib.Contract(
        position.token0,
        _ERC20_BAL_ABI,
        provider,
      ).balanceOf(poolState.poolAddress),
      new ethersLib.Contract(
        position.token1,
        _ERC20_BAL_ABI,
        provider,
      ).balanceOf(poolState.poolAddress),
    ]);
    const p0f = toFloat(pool0, poolState.decimals0),
      p1f = toFloat(pool1, poolState.decimals1);
    posStats.poolShare0Pct =
      p0f > 0 ? Math.min(100, (amounts.amount0 / p0f) * 100) : 0;
    posStats.poolShare1Pct =
      p1f > 0 ? Math.min(100, (amounts.amount1 / p1f) * 100) : 0;
  } catch {
    /* non-critical */
  }
}

/**
 * Compute this position's pro-rata share of wallet token balances.
 * Each token's wallet balance is split across all managed positions
 * that use it, proportional to the in-position amount.
 *
 * @returns {{ usd: number, amount0: number, amount1: number,
 *   wallet?: {raw0: bigint, raw1: bigint} }}
 *   amount0/amount1 are human-readable floats (this position's share).
 *   `wallet` is the whole wallet's two coins as read, in their smallest
 *   units, which the deposit count's rise check compares with the last
 *   poll's (src/lib/deposit-count.js).
 */
async function walletResiduals(
  deps,
  ethersLib,
  provider,
  position,
  poolState,
  price0,
  price1,
) {
  const empty = { usd: 0, usd0: 0, usd1: 0, amount0: 0, amount1: 0 };
  try {
    const addr = await deps.signer.getAddress();
    const t0c = new ethersLib.Contract(
      position.token0,
      _ERC20_BAL_ABI,
      provider,
    );
    const t1c = new ethersLib.Contract(
      position.token1,
      _ERC20_BAL_ABI,
      provider,
    );
    const [wb0, wb1] = await Promise.all([
      t0c.balanceOf(addr),
      t1c.balanceOf(addr),
    ]);
    const d0 = poolState.decimals0,
      d1 = poolState.decimals1;
    const wf0 = toFloat(wb0, d0),
      wf1 = toFloat(wb1, d1);
    // This position's in-range token amounts
    const pa = rangeMath.positionAmounts(
      position.liquidity || 0,
      poolState.tick,
      position.tickLower,
      position.tickUpper,
      d0,
      d1,
    );
    // Pro-rata: query all managed positions' amounts for shared tokens
    const gta = deps._getTokenPositionAmounts;
    const total0 = gta ? gta(position.token0) : pa.amount0;
    const total1 = gta ? gta(position.token1) : pa.amount1;
    const share0 = total0 > 0 ? (pa.amount0 / total0) * wf0 : wf0;
    const share1 = total1 > 0 ? (pa.amount1 / total1) * wf1 : wf1;
    const usd0 = share0 * price0;
    const usd1 = share1 * price1;
    return {
      usd: usd0 + usd1,
      usd0,
      usd1,
      amount0: share0,
      amount1: share1,
      wallet: { raw0: BigInt(wb0), raw1: BigInt(wb1) },
    };
  } catch (_) {
    return empty;
  }
}

/** Pick the larger of two candidate amounts. */
function _maxAmount(a, b) {
  return a > b ? a : b;
}

const {
  totalLifetimeDeposit: _totalLifetimeDeposit,
} = require("./bot-deposit");

/** Write residual USD + per-token coin amounts onto the snapshot. */
function _applyResiduals(snap, residuals, rUsd) {
  snap.residualValueUsd = rUsd;
  snap.residualUsd0 = residuals?.usd0 || 0;
  snap.residualUsd1 = residuals?.usd1 || 0;
  snap.residualAmount0 = residuals?.amount0 || 0;
  snap.residualAmount1 = residuals?.amount1 || 0;
}

/** Override P&L snapshot with real on-chain values and HODL-based IL. */
async function overridePnlWithRealValues(
  snap,
  deps,
  position,
  poolState,
  price0,
  price1,
  feesUsd,
  residuals,
) {
  const realValue = positionValueUsd(position, poolState, price0, price1);
  const rUsd = residuals?.usd || 0;
  _applyResiduals(snap, residuals, rUsd);
  applyInitialResidual(snap, deps);
  snap.currentValue = realValue;
  /*- New lifetime-fee model: expose `currentFeesUsd` (live unclaimed)
   *  and `totalCompoundedUsd` (historical Σ(Collect)−Σ(DL) scan) as
   *  the two fee fields.  Old `snap.totalFees` per-epoch sum is gone
   *  — it missed fees folded into rebalances (HEX/eHEX was off by
   *  $100+, ~1/3 of correct value).  Consumers add the two fields
   *  for the lifetime fee-earnings figure. */
  snap.currentFeesUsd = feesUsd;
  const entryVal = snap.liveEpoch
    ? snap.liveEpoch.entryValue
    : snap.initialDeposit;
  /*-
   *  Priced here, never stored. The saved figure is the coins the
   *  position compounded (`compoundedAmount0` / `compoundedAmount1`),
   *  established by the lifetime scan's chain-wide classification and
   *  added to by every compound and rebalance thereafter — absent until
   *  that scan runs, which prices to zero rather than to a partial
   *  figure. Valuing them at this poll's prices is what keeps the
   *  Lifetime panel true as the pair moves; a dollar total saved at
   *  yesterday's price drifts further every day the position runs.
   */
  const saved0 = deps._botState?.compoundedAmount0;
  const saved1 = deps._botState?.compoundedAmount1;
  const compounded = coinsToUsd(
    { amount0: saved0, amount1: saved1 },
    price0,
    price1,
  );
  /*- Null, not zero, while the chain has yet to be classified. The two
   *  are different facts — "nothing compounded" against "not known yet" —
   *  and the Lifetime panel draws them differently: a figure for the
   *  first, an em-dash for the second. Every arithmetic consumer
   *  coalesces to zero, so only the display changes. */
  snap.totalCompoundedUsd = hasCompoundedTotal(saved0, saved1)
    ? compounded
    : null;
  /*-
   *  snap.currentCompoundedUsd, snap.currentFeesLeftUsd and
   *  snap.currentGasUsd are populated by the bot-loop-injected
   *  `applyCurrentNftFigures` hook (see deps wiring in bot-loop.js,
   *  implementation in bot-pnl-current-nft.js).  Kept out of
   *  bot-pnl-updater so the heavy compounder/ethers require chain only
   *  loads when the actual bot cycle runs, not when test mocks
   *  (bot-hodl-scan) require this module with a partial ethers stub.
   *  Default to 0 so consumers reading the snapshot before the hook runs
   *  see a stable shape rather than `undefined`.
   */
  snap.currentCompoundedUsd = 0;
  snap.currentFeesLeftUsd = 0;
  /*-
   *  The Lifetime panel's Gas line is the whole position's gas coins
   *  priced now, the way every other lifetime figure is priced now, and
   *  `_openNftMintGasNative` supplies the one part of "the whole
   *  position" the periods do not carry.
   *
   *  The Per-Day table is deliberately NOT re-priced here. Each of its
   *  rows is a closed accounting period, and a closed period keeps the
   *  dollars it closed at — its fees and price movement already do.
   *  Gas re-priced on every poll would be the one column in that table
   *  whose history moved with the native token, and it would carry
   *  Profit and Net P&L with it, since both subtract gas.
   *
   *  The two therefore answer different questions and will not agree
   *  once the native token has moved: the Lifetime line says what this
   *  position's gas is worth today, the column says what each period's
   *  gas cost at the time. Documented for the operator in the table's
   *  own help dialog.
   */
  /*- Added, not `+=`d onto whatever is there. A snapshot arriving
   *  without `totalGasNative` would make `+=` produce NaN, and NaN in a
   *  gas figure is not one wrong reading: `totalGas` feeds the Lifetime
   *  line, Net P&L and Profit, and compares false against every
   *  threshold it meets. `snapshot()` always supplies the field, so this
   *  guards the exported function against a caller that does not. */
  const mintNative = _openNftMintGasNative(deps, snap);
  if (mintNative > 0)
    snap.totalGasNative = (snap.totalGasNative ?? 0) + mintNative;
  if (snap.totalGasNative > 0) {
    try {
      const nativePrice = await fetchTokenPriceUsd(
        config.CHAIN.nativeWrappedToken,
      );
      snap.totalGas = snap.totalGasNative * nativePrice;
    } catch {
      /* keep historical USD sums as fallback */
    }
  }
  // currentValue is LP-only; residuals tracked separately
  snap.priceChangePnl = snap.currentValue - entryVal;
  /*- cumulativePnl / netReturn (lifetime totals): fold fee earnings as
   *  compounded + currentFees (additive — both are real earnings,
   *  compounded is already swept back into liquidity).  No subtraction
   *  term for compounded: it's part of the fee figure, not a discount. */
  const feeEarnings = compounded + feesUsd;
  snap.cumulativePnl = snap.priceChangePnl + feeEarnings - snap.totalGas;
  snap.netReturn = feeEarnings - snap.totalGas + snap.priceChangePnl;
  const decimals = {
    decimals0: poolState.decimals0,
    decimals1: poolState.decimals1,
  };
  _computeIL(
    snap,
    deps,
    realValue,
    price0,
    price1,
    position?.tokenId,
    decimals,
  );
  if (deps._botState?.totalLifetimeDepositUsd > 0) {
    /*-
     *  With what polls have counted since the last move's count, which
     *  the saved total does not hold yet (src/lib/counted-deposits.js).
     */
    const polled = pollDeposits(
      deps._botState.lifetimeHodlAmounts,
      deps._botState._depositOverlay,
      decimals.decimals0,
      decimals.decimals1,
    );
    snap.totalLifetimeDeposit =
      deps._botState.totalLifetimeDepositUsd + polled.usd;
    snap.depositUsedFallback = deps._botState.depositUsedFallback || false;
  }
}

/**
 * Estimate a rebalance's gas cost in USD before it starts: the chain's
 * `estimatedRebalanceGasUnits` in chains.json, at the network's current
 * gas price and the native token's current price.
 */
async function estimateGasCostUsd(provider) {
  try {
    const f = await provider.getFeeData();
    const units = BigInt(config.CHAIN.estimatedRebalanceGasUnits);
    const c = (f.gasPrice ?? 0n) * units;
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    return (Number(c) / 1e18) * p;
  } catch {
    return 0;
  }
}

/**
 * Compute actual gas cost in USD from total PLS spent (in wei), at the
 * native token's current price: right for gas being spent now, which is
 * every live rebalance, compound and cancel.
 *
 * @param {bigint|number} gasCostWei  Native token spent, in wei.
 * @returns {Promise<number>} USD cost, or 0 when no price could be had.
 */
async function actualGasCostUsd(gasCostWei) {
  try {
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    return (Number(gasCostWei) / 1e18) * p;
  } catch {
    return 0;
  }
}

/**
 * The gas a closed period spent, in USD at the native token's price on
 * the day it was spent, so a charge from months ago is valued at what it
 * cost rather than at today's market.
 *
 * Null when that day's price cannot be read. The Per-Day table then
 * shows a dash for the period's gas, and for the Profit and Net P&L that
 * subtract it, rather than a figure at today's price.
 *
 * @param {bigint|number} gasCostWei  Native token spent, in wei.
 * @param {object} when               When the gas was spent.
 * @param {number} when.timestamp     Unix seconds of the charge.
 * @param {number} [when.blockNumber] Block of the charge, for Moralis.
 * @param {boolean} [when.refresh]    Read past the price cache and
 *   replace what it holds, rather than trusting a cached day.
 * @returns {Promise<number|null>} USD cost, or null when the day's price
 *   could not be read.
 */
async function pastGasCostUsd(gasCostWei, when) {
  let price = 0;
  try {
    price = await fetchHistoricalTokenPriceUsd(
      config.CHAIN.nativeWrappedToken,
      {
        timestamp: when.timestamp,
        blockNumber: when.blockNumber,
        refresh: when.refresh === true,
      },
    );
  } catch (err) {
    log.warn(
      "[bot] gas: native price for ts=%s: %s",
      when.timestamp,
      err.message,
    );
  }
  if (price > 0) return (Number(gasCostWei) / 1e18) * price;
  log.warn(
    "[bot] gas: no native price for ts=%s — its Per-Day gas shows a dash",
    when.timestamp,
  );
  return null;
}

/** Fetch token prices, applying per-position overrides when fetcher returns 0. */
async function _fetchWithOverrides(position, deps) {
  const fetched = await fetchTokenPrices(position.token0, position.token1);
  return applyPriceOverrides(fetched, deps._getConfig);
}

/** Fetch P&L snapshot and publish position stats to the dashboard. */
async function updatePnlAndStats(deps, poolState, ethersLib) {
  const { provider, position, updateBotState } = deps;
  const lp = rangeMath.tickToPrice(
    position.tickLower,
    poolState.decimals0,
    poolState.decimals1,
  );
  const up = rangeMath.tickToPrice(
    position.tickUpper,
    poolState.decimals0,
    poolState.decimals1,
  );
  const ratio = rangeMath.compositionRatio(poolState.price, lp, up);
  const pnlTracker = deps._pnlTracker;
  let pnlSnapshot = null;
  if (pnlTracker) {
    try {
      const { price0, price1 } = await _fetchWithOverrides(position, deps);
      ensureLiveEpoch(pnlTracker, deps._botState, {
        currentValue: positionValueUsd(position, poolState, price0, price1),
        entryPrice: poolState.price,
        lowerPrice: lp,
        upperPrice: up,
        price0,
        price1,
      });
      const fees = await readUnclaimedFees(
        provider,
        ethersLib,
        position.tokenId,
        deps.signer,
      );
      const fee0 = toFloat(fees.tokensOwed0, poolState.decimals0);
      const fee1 = toFloat(fees.tokensOwed1, poolState.decimals1);
      const feesUsd = fee0 * price0 + fee1 * price1;
      if (config.VERBOSE)
        log.info(
          "[bot] fees: owed0=%s owed1=%s dec0=%d dec1=%d p0=%s p1=%s usd=%s",
          String(fees.tokensOwed0),
          String(fees.tokensOwed1),
          poolState.decimals0,
          poolState.decimals1,
          price0,
          price1,
          feesUsd.toFixed(6),
        );
      deps._lastUnclaimedFeesUsd = feesUsd;
      /*- The token amounts behind that figure, kept alongside it so the
       *  compound decision can re-value the same fees at fresh prices
       *  without re-reading the position from chain. The USD above is
       *  computed with whatever prices this poll had, which the idle
       *  pause can answer from cache of any age — fine for display,
       *  not for deciding whether to spend gas. */
      deps._lastUnclaimedFee0 = fee0;
      deps._lastUnclaimedFee1 = fee1;
      deps._lastPrice0 = price0;
      deps._lastPrice1 = price1;
      const residuals = await walletResiduals(
        deps,
        ethersLib,
        provider,
        position,
        poolState,
        price0,
        price1,
      );
      /*-
       *  Coins that rose in the wallet since the last poll may be a
       *  deposit, which the figures below must not read as a gain: the
       *  deposit count runs first. Injected like the per-NFT figures
       *  below, so this file loads no chain-scanning module.
       */
      if (deps._countDepositsOnRise)
        await deps._countDepositsOnRise(deps, residuals.wallet);
      const nftCompoundedUsd = nftCoinsToUsd(
        deps._botState?.nftCompoundedAmountsByTokenId,
        position.tokenId,
        price0,
        price1,
      );
      pnlTracker.updateLiveEpoch({
        currentPrice: poolState.price,
        feesAccrued: feesUsd,
        /*- The coins this NFT compounded, priced at this poll — filled by
         *  applyCurrentNftFigures (bot-pnl-current-nft.js).  Absent on the
         *  first poll after a rebalance mints a new tokenId, which reads
         *  as 0 until that scan lands — the same figure the Current panel
         *  shows. */
        compoundedAccrued: nftCompoundedUsd,
      });
      pnlSnapshot = pnlTracker.snapshot(
        poolState.price,
        deps._botState?.failedMoveGas ?? [],
      );
      await overridePnlWithRealValues(
        pnlSnapshot,
        deps,
        position,
        poolState,
        price0,
        price1,
        feesUsd,
        residuals,
      );
      /*-
       *  Per-NFT Current panel figures (currentGasUsd, override of
       *  currentCompoundedUsd from cache).  Injected via deps so the
       *  compounder/ethers require chain only loads when bot-cycle wires
       *  it up — keeps bot-hodl-scan tests' partial ethers stub working.
       */
      if (deps._applyCurrentNftFigures) {
        try {
          await deps._applyCurrentNftFigures(
            pnlSnapshot,
            deps,
            position,
            poolState,
          );
        } catch (err) {
          log.warn(
            "[bot] applyCurrentNftFigures hook error: %s",
            err.message || err,
          );
        }
      }
    } catch (err) {
      log.warn("[bot] P&L update error:", err.message);
    }
  }
  if (updateBotState) {
    const amounts = rangeMath.positionAmounts(
      position.liquidity,
      poolState.tick,
      position.tickLower,
      position.tickUpper,
      poolState.decimals0,
      poolState.decimals1,
    );
    const posStats = {
      compositionRatio: ratio,
      balance0: amounts.amount0.toFixed(6),
      balance1: amounts.amount1.toFixed(6),
    };
    await addPoolShare(
      posStats,
      amounts,
      position,
      poolState,
      ethersLib,
      provider,
    );
    updateBotState({
      poolState: {
        price: poolState.price,
        tick: poolState.tick,
        decimals0: poolState.decimals0,
        decimals1: poolState.decimals1,
        poolAddress: poolState.poolAddress,
        tickSpacing: poolState.tickSpacing,
      },
      positionStats: posStats,
      ...(pnlSnapshot ? { pnlSnapshot } : {}),
    });
  }
  /*- Balanced-band Telegram notifier (opt-in via the "Position Balanced"
   *  Telegram event).  No-op when the toggle is off, so no price-source
   *  load.  When on, the notifier throttles its own fresh-price probe
   *  via `pricePauseExceptionPollWindowMultiple` (default 10 → every
   *  10× the bot poll interval).  Errors are swallowed so a notifier
   *  bug can never break the poll cycle. */
  if (deps._botState) {
    try {
      await maybeNotifyBalanced({
        position,
        poolState,
        botState: deps._botState,
        snap: pnlSnapshot,
        checkIntervalSec: config.CHECK_INTERVAL_SEC,
        multiplier: _resolveBalancedMultiplier(deps),
      });
    } catch (err) {
      log.warn("[balanced-notifier] hook error: %s", err.message || err);
    }
  }
  return pnlSnapshot;
}

module.exports = {
  toFloat,
  positionValueUsd,
  fetchTokenPrices,
  readUnclaimedFees,
  addPoolShare,
  walletResiduals,
  overridePnlWithRealValues,
  estimateGasCostUsd,
  actualGasCostUsd,
  pastGasCostUsd,
  updatePnlAndStats,
  _maxAmount,
  _totalLifetimeDeposit,
};
