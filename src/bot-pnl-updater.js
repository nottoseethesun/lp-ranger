/**
 * @file src/bot-pnl-updater.js
 * @module bot-pnl-updater
 * @description
 * P&L snapshot computation and position stats for the bot poll cycle.
 * Extracted from bot-loop.js to stay within the 500-line limit.
 *
 * All functions receive their dependencies as parameters — no module-level state.
 */

"use strict";

const config = require("./config");
const rangeMath = require("./range-math");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { computeHodlIL } = require("./il-calculator");
const { PM_ABI } = require("./pm-abi");

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
  return a.amount0 * pr0 + a.amount1 * pr1;
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
      console.warn(
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

/** Compute the USD value of wallet residuals, capped to actual balances. */
async function residualValueUsd(
  deps,
  ethersLib,
  provider,
  position,
  poolState,
  price0,
  price1,
) {
  const rt = deps._residualTracker;
  if (!rt || !poolState.poolAddress) return 0;
  try {
    const addr = await deps.signer.getAddress();
    const t0 = new ethersLib.Contract(
      position.token0,
      _ERC20_BAL_ABI,
      provider,
    );
    const t1 = new ethersLib.Contract(
      position.token1,
      _ERC20_BAL_ABI,
      provider,
    );
    const [wb0, wb1] = await Promise.all([
      t0.balanceOf(addr),
      t1.balanceOf(addr),
    ]);
    return rt.cappedValueUsd(
      poolState.poolAddress,
      wb0,
      wb1,
      price0,
      price1,
      poolState.decimals0,
      poolState.decimals1,
    );
  } catch (_) {
    return 0;
  }
}

/** Sum compound USD values that fall within the live epoch's timeframe. */
function _currentEpochCompounded(snap, deps) {
  const history = deps._botState?.compoundHistory;
  if (!history || !history.length || !snap.liveEpoch) return 0;
  const epochStart = snap.liveEpoch.openTime || 0;
  let sum = 0;
  for (const c of history) {
    if (new Date(c.timestamp).getTime() >= epochStart) sum += c.usdValue || 0;
  }
  return sum;
}

function _computeLifetimeFees(snap, deps, feesUsd) {
  const cf = snap.totalFees - (snap.liveEpoch?.fees ?? 0);
  // Compounded fees are both collected AND re-deposited. For live compounds,
  // _collectedFeesUsd already includes them. For historical compounds detected
  // on-chain, only totalCompoundedUsd is set. Use the larger of the two.
  const compounded = deps._botState?.totalCompoundedUsd || 0;
  const collected = Math.max(deps._collectedFeesUsd || 0, compounded);
  return Math.max(collected, cf) + feesUsd;
}
function _hodlAmounts(source, bl) {
  return {
    a0: source?.hodlAmount0 || bl?.hodlAmount0 || 0,
    a1: source?.hodlAmount1 || bl?.hodlAmount1 || 0,
  };
}

function _computeIL(snap, deps, realValue, price0, price1) {
  const bl = deps._botState?.hodlBaseline;
  const _il = (a0, a1) =>
    a0 > 0 || a1 > 0
      ? computeHodlIL({
          lpValue: realValue,
          hodlAmount0: a0,
          hodlAmount1: a1,
          currentPrice0: price0,
          currentPrice1: price1,
        })
      : undefined;
  const curA0 = bl?.hodlAmount0 || 0,
    curA1 = bl?.hodlAmount1 || 0;
  snap.totalIL = _il(curA0, curA1);
  const first = Array.isArray(snap.closedEpochs) ? snap.closedEpochs[0] : null;
  const { a0, a1 } = _hodlAmounts(first, bl);
  snap.lifetimeIL = _il(a0, a1);
  snap.ilInputs = {
    lpValue: realValue,
    price0,
    price1,
    cur: { hodlAmount0: curA0, hodlAmount1: curA1 },
    lt: { hodlAmount0: a0, hodlAmount1: a1 },
  };
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
  rUsd,
) {
  const realValue = positionValueUsd(position, poolState, price0, price1);
  const lifetimeFees = _computeLifetimeFees(snap, deps, feesUsd);
  snap.residualValueUsd = rUsd || 0;
  snap.currentValue = realValue;
  snap.totalFees = lifetimeFees;
  const entryVal = snap.liveEpoch
    ? snap.liveEpoch.entryValue
    : snap.initialDeposit;
  const compounded = deps._botState?.totalCompoundedUsd || 0;
  snap.totalCompoundedUsd = compounded;
  snap.currentCompoundedUsd = _currentEpochCompounded(snap, deps);
  // Recompute all gas in current USD: gasNative × current native token price
  if (snap.totalGasNative > 0) {
    try {
      const nativePrice = await fetchTokenPriceUsd(
        config.CHAIN.nativeWrappedToken,
      );
      snap.totalGas = snap.totalGasNative * nativePrice;
      // Recompute per-day gas costs at current price
      if (snap.dailyPnl) {
        for (const day of snap.dailyPnl) {
          if (day.gasNative > 0) day.gasCost = day.gasNative * nativePrice;
        }
      }
    } catch {
      /* keep historical USD sums as fallback */
    }
  }
  snap.priceChangePnl = realValue - entryVal;
  snap.cumulativePnl =
    snap.priceChangePnl + lifetimeFees - snap.totalGas - compounded;
  snap.netReturn =
    lifetimeFees - snap.totalGas + snap.priceChangePnl - compounded;
  _computeIL(snap, deps, realValue, price0, price1);
}

/**
 * Apply initial mint gas to the P&L tracker (once).
 * The HODL baseline stores `mintGasWei` from the mint TX receipt.
 * Convert to USD and add to the live epoch's gas on first encounter.
 */
async function _applyMintGas(deps, pnlTracker) {
  // Guard flag must be on _botState (persists across polls), not on deps
  // (recreated every poll cycle — see bot-loop.js poll closure).
  if (deps._botState?._mintGasApplied) return;
  const bl = deps._botState?.hodlBaseline;
  if (!bl?.mintGasWei || bl.mintGasWei === "0") return;
  const wei = BigInt(bl.mintGasWei);
  if (wei <= 0n) return;
  const usd = await actualGasCostUsd(wei);
  const native = Number(wei) / 1e18;
  if (usd > 0) {
    pnlTracker.addGas(usd, native);
    if (deps._botState) deps._botState._mintGasApplied = true;
    console.log("[bot] Applied initial mint gas: $%s", usd.toFixed(4));
  }
}

/** Estimate gas cost in USD for a rebalance (~800k gas). */
async function estimateGasCostUsd(provider) {
  try {
    const f = await provider.getFeeData();
    const c = (f.gasPrice ?? 0n) * 800_000n;
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    return (Number(c) / 1e18) * p;
  } catch {
    return 0;
  }
}

/** Compute actual gas cost in USD from total PLS spent (in wei). */
async function actualGasCostUsd(gasCostWei) {
  try {
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    return (Number(gasCostWei) / 1e18) * p;
  } catch {
    return 0;
  }
}

/** Fetch token prices, applying per-position overrides when fetcher returns 0. */
async function _fetchWithOverrides(position, deps) {
  let { price0, price1 } = await fetchTokenPrices(
    position.token0,
    position.token1,
  );
  const gc = deps._getConfig || (() => undefined);
  const ov0 = gc("priceOverride0"),
    ov1 = gc("priceOverride1");
  const force = gc("priceOverrideForce");
  if (ov0 > 0 && (force || price0 <= 0)) {
    console.log(
      "[pnl] using priceOverride0=%s (fetched=%s force=%s)",
      ov0,
      price0,
      !!force,
    );
    price0 = ov0;
  }
  if (ov1 > 0 && (force || price1 <= 0)) {
    console.log(
      "[pnl] using priceOverride1=%s (fetched=%s force=%s)",
      ov1,
      price1,
      !!force,
    );
    price1 = ov1;
  }
  return { price0, price1 };
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
      if (!pnlTracker.getLiveEpoch()) {
        const ev = positionValueUsd(position, poolState, price0, price1) || 1;
        pnlTracker.openEpoch({
          entryValue: ev,
          entryPrice: poolState.price,
          lowerPrice: lp,
          upperPrice: up,
          token0UsdPrice: price0,
          token1UsdPrice: price1,
        });
        console.log(
          "[bot] Auto-opened missing live epoch (entryValue=$%s)",
          ev.toFixed(2),
        );
      }
      const fees = await readUnclaimedFees(
        provider,
        ethersLib,
        position.tokenId,
        deps.signer,
      );
      const feesUsd =
        toFloat(fees.tokensOwed0, poolState.decimals0) * price0 +
        toFloat(fees.tokensOwed1, poolState.decimals1) * price1;
      if (config.VERBOSE)
        console.log(
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
      deps._lastPrice0 = price0;
      deps._lastPrice1 = price1;
      const rUsd = await residualValueUsd(
        deps,
        ethersLib,
        provider,
        position,
        poolState,
        price0,
        price1,
      );
      pnlTracker.updateLiveEpoch({
        currentPrice: poolState.price,
        feesAccrued: feesUsd,
      });
      await _applyMintGas(deps, pnlTracker);
      pnlSnapshot = pnlTracker.snapshot(
        poolState.price,
        deps._botState?.poolFirstMintDate,
      );
      await overridePnlWithRealValues(
        pnlSnapshot,
        deps,
        position,
        poolState,
        price0,
        price1,
        feesUsd,
        rUsd,
      );
    } catch (err) {
      console.warn("[bot] P&L update error:", err.message);
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
      },
      positionStats: posStats,
      ...(pnlSnapshot ? { pnlSnapshot } : {}),
    });
  }
}

module.exports = {
  toFloat,
  positionValueUsd,
  fetchTokenPrices,
  readUnclaimedFees,
  addPoolShare,
  residualValueUsd,
  overridePnlWithRealValues,
  estimateGasCostUsd,
  actualGasCostUsd,
  updatePnlAndStats,
  _applyMintGas,
};
