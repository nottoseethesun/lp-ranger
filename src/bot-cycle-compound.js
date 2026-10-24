/**
 * @file bot-cycle-compound.js
 * @description Compound execution, recording, and throttle logic for the
 *   bot poll cycle. Split from bot-cycle.js for line-count compliance.
 */

"use strict";

const { log } = require("./log");
const { logCtx } = require("./logger");
const config = require("./config");
const {
  actualGasCostUsd: _actualGasCostUsd,
  fetchTokenPrices,
} = require("./bot-pnl-updater");
const { notify } = require("./telegram-notifications/telegram");
const { getTokenSymbol } = require("./token-symbol-cache");
const { executeCompound: runCompound } = require("./compounder");
const { compoundFiguresAtCreation } = require("./compound-activity-figures");
const { coinsToUsd, isCoinPair } = require("./coin-value");
const { spentGasOf, recordSpentGas } = require("./spent-gas");
const { countDeposits } = require("./deposit-count");
const { isAscanRunningOnThisPosition } = require("./scan-state");
const {
  withFreshPricesAllowed,
  invalidatePriceCacheFor,
} = require("./price-fetcher");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const {
  hasCompoundedTotal,
  isRecordedCoinTotal,
} = require("./bot-config-keys");

/*-
 *  Default for the approvalMultiple per-position config fallback
 *  below: the shipped value, or the operator's override of it.  Per
 *  feedback_one_literal_per_shipped_default, the literal lives only in
 *  bot-config-defaults.json.
 */
const _DEFAULTS = readBotConfigDefaults();

/**
 * Check if compound conditions are met and execute if so.
 * @returns {Promise<boolean>} true if executeCompound was attempted this cycle.
 */
/**
 * Value this position's unclaimed fees at prices fetched right now.
 *
 * The poll's own figure (`_lastUnclaimedFeesUsd`) is computed with
 * whatever prices that poll had, and the idle pause answers a price
 * read from cache with no age limit — or with nothing at all on a
 * process that has never fetched one, which is every headless
 * `npm run bot` start.  Deciding to spend gas on a compound wants a
 * current number, so the token amounts are re-valued here inside
 * `withFreshPricesAllowed`.
 *
 * Re-values rather than re-reads: the fee amounts were already read
 * from chain this poll and are carried alongside the USD, so this costs
 * one price lookup and no extra RPC.
 *
 * Falls back to the poll's figure when the amounts are absent (nothing
 * has populated them yet) or when the fresh fetch yields no price.
 * Compounding is low-risk — collect and re-deposit on the same NFT, no
 * range change — so a price outage delaying it indefinitely is worse
 * than acting on the last known valuation.
 *
 * @param {object} deps      Bot deps carrying the position and last read.
 * @param {boolean} [forced]  True for a manual compound, which skips
 *   every threshold comparison — so a fresh price could not change its
 *   outcome, and fetching one would buy nothing but a network call. The
 *   compound itself still fetches fresh prices for the work it does.
 * @returns {Promise<number>}  Unclaimed fees in USD.
 */
async function _freshFeesUsd(deps, forced) {
  const last = deps._lastUnclaimedFeesUsd || 0;
  if (forced === true) return last;
  const fee0 = deps._lastUnclaimedFee0;
  const fee1 = deps._lastUnclaimedFee1;
  if (fee0 === undefined || fee0 === null) return last;
  if (fee1 === undefined || fee1 === null) return last;
  const { price0, price1 } = await withFreshPricesAllowed(() =>
    fetchTokenPrices(deps.position.token0, deps.position.token1),
  );
  if (!(price0 > 0) || !(price1 > 0)) return last;
  return fee0 * price0 + fee1 * price1;
}

async function checkCompound(deps, poolState, ethersLib, refreshPosition) {
  const botSt = deps._botState || {};
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const forced = !!botSt.forceCompound;
  const autoEnabled = _gc("autoCompoundEnabled") || false;
  const threshold =
    _gc("autoCompoundThresholdUsd") || config.COMPOUND_DEFAULT_THRESHOLD_USD;
  /*- Order matters here.  The gates that cost nothing run first, and
   *  only then are the fees re-valued — so the price fetch below is
   *  paid for once per throttle window on a position that is actually
   *  a compound candidate, not on every poll.  Reordering is safe
   *  because each gate is an independent read with no side effect; all
   *  that changes is which one answers first. */
  if (!forced && !autoEnabled) return false;
  /*- Reload / initial-scan window: skip auto-compound while a scan runs
   *  (src/scan-state.js), so the compound doesn't race the state
   *  reconstruction.  A Compound Now (`forced === true`) never meets a
   *  running scan: the server refuses it then, and no scan starts while
   *  one waits. */
  if (!forced && isAscanRunningOnThisPosition(botSt)) return false;

  /*-
   *  Auto-compound spacing: app-runtime.json → compound.autoSpacingPolls
   *  polls of CHECK_INTERVAL_SEC, never less than
   *  compound.autoSpacingFloorSec, so a short poll interval cannot mean
   *  a compound on every poll. All three are checked at startup by
   *  src/config.js.
   */
  const lastAt = _gc("lastCompoundAt");
  if (!forced && lastAt) {
    const interval =
      Math.max(
        config.CHECK_INTERVAL_SEC * config.COMPOUND_AUTO_SPACING_POLLS,
        config.COMPOUND_AUTO_SPACING_FLOOR_SEC,
      ) * 1000;
    if (Date.now() - new Date(lastAt).getTime() < interval) return false;
  }

  const feesUsd = await _freshFeesUsd(deps, forced);
  if (!forced && feesUsd < threshold) return false;
  if (!forced && feesUsd < config.COMPOUND_MIN_FEE_USD) return false;

  log.info(
    "[bot] Compound triggered (forced=%s fees=$%s threshold=$%s)",
    forced,
    feesUsd.toFixed(2),
    threshold,
  );
  await executeCompound(deps, poolState, ethersLib, forced ? "manual" : "auto");
  // Refresh position from chain — liquidity increased after compound
  await refreshPosition(deps.position, ethersLib, deps.provider);
  return true;
}

/**
 * The compounded-coins fields a recorded compound contributes, or `null`
 * when it contributes none.
 *
 * Add the coins, never a dollar total: the saved figure has to stay true
 * at whatever price the next poll reads, and a sum of dollars frozen at
 * each compound's own price drifts further from that the longer the
 * position runs.
 *
 * And add only to a total that already exists. With none saved, the
 * chain has not been classified yet — see `hasCompoundedTotal` in
 * `bot-config-keys.js` — and writing this compound's coins there would
 * pass one compound off as the whole chain's, which the lifetime scan
 * then reads as proof its work is done.
 *
 * @param {number|undefined|null} saved0  Saved token0 compounded coins.
 * @param {number|undefined|null} saved1  Saved token1 compounded coins.
 * @param {number} fee0  Token0 fees this compound re-deposited.
 * @param {number} fee1  Token1 fees this compound re-deposited.
 * @returns {{compoundedAmount0: number, compoundedAmount1: number}|null}
 */
function _compoundedTotalFields(saved0, saved1, fee0, fee1) {
  if (!hasCompoundedTotal(saved0, saved1)) return null;
  /*- Each side on its own merit. Either alone establishes the total, so
   *  the other may still hold anything the config can express — and a
   *  falsy-fallback would pass a string straight through to be
   *  concatenated rather than summed. */
  return {
    compoundedAmount0: (isRecordedCoinTotal(saved0) ? saved0 : 0) + fee0,
    compoundedAmount1: (isRecordedCoinTotal(saved1) ? saved1 : 0) + fee1,
  };
}

/**
 * Ask the next lifetime scan to classify the chain, because coins just
 * went unrecorded.
 *
 * A writer that finds no established total adds nothing, and the coins it
 * declined to add live only on chain until a classification counts them.
 * Nearly always the scan that follows reads a chain that already holds
 * them and this request costs nothing. It matters when the coins land
 * DURING a scan: that scan read the chain before they existed, so without
 * a request outstanding its write would settle a total that omits them
 * for good. `_recordScanSuccess` clears only requests a scan carried in,
 * so one raised mid-scan survives to the next pass.
 *
 * Set on the live state as well as the patch: the scan reads
 * `botState._needsCompoundReclassify` directly, and waiting for the patch
 * to round-trip through persistence would miss the very pass this is
 * meant to reach.
 *
 * @param {object} deps   Bot deps; `_botState` is the live state.
 * @param {object} patch  Bot-state patch being assembled.
 */
function _requestCompoundReclassify(deps, patch) {
  if (deps._botState) deps._botState._needsCompoundReclassify = true;
  patch._needsCompoundReclassify = true;
}

/**
 * The fees a compound put back into the position, in whole coins: the
 * fees among the coins its deposit took (src/compounded-coins.js), or,
 * for a result without the readings that tell them apart, all it took.
 *
 * @param {object} result  The compound's result.
 * @returns {{amount0: number, amount1: number}}
 */
function _feesPutBack(result) {
  if (isCoinPair(result.feesCompounded)) return result.feesCompounded;
  return {
    amount0: result.depositedAmount0 || 0,
    amount1: result.depositedAmount1 || 0,
  };
}

/**
 * Whether a compound's deposit took in coins the wallet held before its
 * collect: its fees differ from what it deposited.
 *
 * @param {object} result  The compound's result.
 * @returns {boolean}
 */
function _tookWalletCoins(result) {
  if (result.amount0Compounded === undefined) return false;
  if (result.amount1Compounded === undefined) return false;
  return (
    result.amount0Compounded !== result.amount0Deposited ||
    result.amount1Compounded !== result.amount1Deposited
  );
}

/**
 * The compound's entry in the position's compound list.
 *
 * `tokenId` is required so the Managed Current panel can filter
 * compoundHistory to the current NFT (matching the Unmanaged scan).
 * Without it the panel would skip live entries and the row would
 * underreport. The fees among the coins it deposited are kept when the
 * compound could tell them apart, so every later reading of this
 * compound, from this list or from the chain, counts only those as Fees
 * Compounded (src/compounded-coins.js).
 *
 * @param {object} deps  Bot deps; `position` is the NFT compounded.
 * @param {object} result  The compound's result.
 * @param {number} gasCostUsd  Its gas, in dollars on the day.
 * @returns {object}
 */
function _historyEntry(deps, result, gasCostUsd) {
  const tokenId = deps.position?.tokenId;
  const entry = {
    timestamp: result.timestamp,
    txHash: result.depositTxHash,
    tokenId: tokenId ? String(tokenId) : undefined,
    amount0Deposited: result.amount0Deposited,
    amount1Deposited: result.amount1Deposited,
    usdValue: result.usdValue,
    price0: result.price0,
    price1: result.price1,
    gasCostUsd,
    trigger: result.trigger,
    // The Activity Log entry's fee coins and Historical figure.
    ...compoundFiguresAtCreation(result, deps.position),
  };
  if (
    result.amount0Compounded !== undefined &&
    result.amount1Compounded !== undefined
  ) {
    entry.amount0Compounded = result.amount0Compounded;
    entry.amount1Compounded = result.amount1Compounded;
  }
  /*- The fees the deposit could not take, waiting in the wallet; the
   *  Current panel counts them among this NFT's fees. */
  if (
    result.amount0FeesLeft !== undefined &&
    result.amount1FeesLeft !== undefined
  ) {
    entry.amount0FeesLeft = result.amount0FeesLeft;
    entry.amount1FeesLeft = result.amount1FeesLeft;
  }
  return entry;
}

/** Record a successful compound: update history, P&L tracker gas, collected fees. */
async function recordCompound(deps, result) {
  const emit = deps.updateBotState || (() => {});
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const gasWei = BigInt(result.gasCostWei || 0);
  const gasCostUsd = gasWei > 0n ? await _actualGasCostUsd(gasWei) : 0;
  const history = _gc("compoundHistory") || [];
  history.push(_historyEntry(deps, result, gasCostUsd));
  /*-
   *  The fees it put back, not the wallet's other coins its deposit took
   *  in: those are no fees, and the running total is what both Lifetime
   *  Fees Compounded and the Lifetime IL/G read.
   */
  const fees = _feesPutBack(result);
  const totals = _compoundedTotalFields(
    _gc("compoundedAmount0"),
    _gc("compoundedAmount1"),
    fees.amount0,
    fees.amount1,
  );
  /*-
   *  Invalidate the per-NFT Current-panel caches for this tokenId so the
   *  next poll re-scans and picks up the new compound's gas + USD.  Cheap
   *  (one per-NFT scan), runs at most once per compound.
   */
  const nftGasMap = { ...(_gc("nftGasWeiByTokenId") || {}) };
  const nftCompMap = { ...(_gc("nftCompoundedAmountsByTokenId") || {}) };
  if (deps.position?.tokenId) {
    const tid = String(deps.position.tokenId);
    delete nftGasMap[tid];
    delete nftCompMap[tid];
  }
  const patch = {
    compoundHistory: history,
    nftGasWeiByTokenId: nftGasMap,
    nftCompoundedAmountsByTokenId: nftCompMap,
    lastCompoundAt: result.timestamp,
  };
  if (totals !== null) Object.assign(patch, totals);
  else _requestCompoundReclassify(deps, patch);
  emit(patch);
  /* Add compound gas to the P&L tracker so it shows in the Gas KPI */
  const tracker = deps._pnlTracker;
  if (tracker && tracker.epochCount() > 0) {
    const gasNative = Number(gasWei) / 1e18;
    tracker.addGas(gasCostUsd, gasNative);
    emit({ pnlEpochs: tracker.serialize() });
  }
  _logCompound(result, gasCostUsd, totals, fees);
}

/**
 * Show the numbers so users can see the residual: collected = full
 * Collect output; reinvested = what the deposit put in, the fees that
 * fit the current tick ratio and, when the swap ran, other coins from
 * the wallet: those it held before the collect, and a deposit that
 * reached it while the compound ran. The fees left over stay in the
 * wallet as residual (tracked by residual-tracker.js). Neither they nor
 * the wallet's coins the deposit took in are counted as compounded.
 *
 * "lifetime" is this pool's cumulative compounded coins across every
 * NFT in the rebalance chain, reported in coins because coins are what
 * is saved; their dollar value belongs to whichever poll displays it.
 */
function _logCompound(result, gasCostUsd, totals, fees) {
  const collectedUsd = result.collectedUsd ?? result.usdValue;
  const feesUsd = coinsToUsd(fees, result.price0, result.price1);
  const walletUsd = Math.max(0, result.usdValue - feesUsd);
  const residualUsd = Math.max(0, collectedUsd - feesUsd);
  const trig = result.trigger === "manual" ? "manual" : "auto";
  log.info("[bot] Compound source: standalone %s Compound op", trig);
  log.info("[bot]   Method: collect fees + increaseLiquidity on the same NFT");
  log.info(
    "[bot]   The fees reinvested are added to lifetime compounded total",
  );
  log.info(
    "[bot] Compound complete: collected $%s reinvested $%s (fees $%s, other coins from the wallet $%s) residual $%s",
    collectedUsd.toFixed(2),
    result.usdValue.toFixed(2),
    feesUsd.toFixed(2),
    walletUsd.toFixed(2),
    residualUsd.toFixed(2),
  );
  log.info(
    "[bot]   gas $%s | lifetime compounded %s",
    gasCostUsd.toFixed(4),
    _lifetimeCoinsText(totals, fees.amount0, fees.amount1),
  );
}

/**
 * The compound's Telegram message: the fees it put back into the
 * position, and the coins the wallet already held that its deposit took
 * in, when it took any.
 *
 * @param {object} result  The compound's result.
 * @returns {string}
 */
function _compoundMessage(result) {
  const fees = _feesPutBack(result);
  const feesUsd = coinsToUsd(fees, result.price0, result.price1);
  const text = `Compounded $${feesUsd.toFixed(2)} in fees`;
  if (!_tookWalletCoins(result)) return text;
  const walletUsd = Math.max(0, (result.usdValue || 0) - feesUsd);
  return `${text}, and put $${walletUsd.toFixed(2)} of coins the wallet already held into the position`;
}

/**
 * The lifetime-compounded half of the compound log line.
 *
 * With no chain total established yet, say so and report this compound's
 * own coins instead — the alternative is printing a figure that leaves
 * out every earlier compound in the chain, which is the confusion this
 * whole rule exists to prevent.
 *
 * @param {{compoundedAmount0: number, compoundedAmount1: number}|null} totals
 * @param {number} fee0  Token0 fees this compound re-deposited.
 * @param {number} fee1  Token1 fees this compound re-deposited.
 * @returns {string}
 */
function _lifetimeCoinsText(totals, fee0, fee1) {
  if (totals === null)
    return (
      "awaiting the chain scan (this compound: " +
      fee0.toFixed(6) +
      "/" +
      fee1.toFixed(6) +
      ")"
    );
  return (
    totals.compoundedAmount0.toFixed(6) +
    "/" +
    totals.compoundedAmount1.toFixed(6)
  );
}

/** Build the opts object passed to compounder.executeCompound. */
async function _buildCompoundOpts(deps, poolState, trigger) {
  const { signer, position } = deps;
  return {
    positionManagerAddress: config.POSITION_MANAGER,
    tokenId: position.tokenId,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
    token0Symbol: position.token0Symbol || "Token0",
    token1Symbol: position.token1Symbol || "Token1",
    recipient: await signer.getAddress(),
    decimals0: poolState.decimals0,
    decimals1: poolState.decimals1,
    price0: deps._lastPrice0 || 0,
    price1: deps._lastPrice1 || 0,
    trigger,
    approvalMultiple:
      deps._getConfig?.("approvalMultiple") ?? _DEFAULTS.approvalMultiple,
    /*- Enable the ratio-correcting swap between collect and
     *  addLiquidity (see compounder-swap.js swapForCompound). */
    poolState,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    swapRouterAddress: config.SWAP_ROUTER,
    /*-
     *  The two per-token settings, passed through as saved. The swap
     *  picks the destination token's one (`resolveSlippagePct`) and
     *  falls back to the default when it is unset — the same answer a
     *  rebalance of this pair would get.
     */
    slippagePctToken0: deps._getConfig?.("slippagePctToken0"),
    slippagePctToken1: deps._getConfig?.("slippagePctToken1"),
    gasFeePct: deps._getConfig?.("gasFeePct"),
  };
}

/**
 * Execute a compound: collect fees → optional ratio-correcting swap →
 * increaseLiquidity.  Acquires the rebalance lock for nonce safety.
 */
async function executeCompound(deps, poolState, ethersLib, trigger) {
  /*- Idle-driven price-lookup pause: drop cached prices for this
   *  position's tokens and run the compound under
   *  `withFreshPricesAllowed` so every downstream price fetch
   *  (compounder-swap, swap-gates, dust) bypasses the pause flag and
   *  the cache TTL.  Counter is decremented in `finally` so a thrown
   *  error still restores the prior pause state. */
  invalidatePriceCacheFor([
    { token: deps.position.token0 },
    { token: deps.position.token1 },
  ]);
  return withFreshPricesAllowed(() =>
    _executeCompoundInner(deps, poolState, ethersLib, trigger),
  );
}

async function _executeCompoundInner(deps, poolState, ethersLib, trigger) {
  const { signer, position } = deps;
  const emit = deps.updateBotState || (() => {});
  const botSt = deps._botState || {};
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  if (lock)
    log.info(
      "[bot] Compound lock acquired for #%s (pending: %d)",
      position.tokenId,
      lock.pending(),
    );
  try {
    /*-
     *  No compound starts on a stopped loop: a server shutting down
     *  would cut it off between the collect and the deposit. Asked once
     *  the lock is held, since the wait for it can span the stop.
     */
    if (deps._isStopped?.() === true) {
      log.info(
        "[bot] %s: compound not started — the bot loop for this position has stopped",
        logCtx({
          chain: config.CHAIN_NAME,
          wallet: deps.address,
          factory: config.POSITION_MANAGER,
          tokenId: position.tokenId,
          symbol0: getTokenSymbol(position.token0),
          symbol1: getTokenSymbol(position.token1),
        }),
      );
      return;
    }
    botSt.forceCompound = false;
    emit({ compoundInProgress: true });
    /*-
     *  The first step: the deposits the owner made since the last count,
     *  recorded as money put in before the compound moves the wallet's
     *  coins (src/deposit-count.js).
     */
    await countDeposits(deps, "move");

    const compoundOpts = await _buildCompoundOpts(deps, poolState, trigger);
    const result = await runCompound(signer, ethersLib, compoundOpts);

    if (result.compounded) {
      await recordCompound(deps, result);
      /*- Clear any prior compoundError on success so the dashboard's
       *  compound-error modal stops re-surfacing. */
      emit({ compoundError: null });
      notify("compoundSuccess", {
        position: {
          tokenId: position.tokenId,
          fee: position.fee,
          token0: position.token0,
          token1: position.token1,
          token0Symbol: getTokenSymbol(position.token0),
          token1Symbol: getTokenSymbol(position.token1),
        },
        message: _compoundMessage(result),
      });
    } else {
      log.info("[bot] Compound skipped: %s", result.reason);
      /*-
       *  A skipped compound can still have paid gas: a collect sent
       *  that found no fees to put back.
       */
      await recordSpentGas(spentGasOf(result), deps, _actualGasCostUsd);
    }
  } catch (err) {
    log.error("[bot] Compound failed:", err.message);
    emit({ compoundError: err.message });
    notify("compoundFail", {
      position: {
        tokenId: position.tokenId,
        fee: position.fee,
        token0: position.token0,
        token1: position.token1,
        token0Symbol: getTokenSymbol(position.token0),
        token1Symbol: getTokenSymbol(position.token1),
      },
      error: err.message,
      message:
        "Note: It is unlikely but possible that the Compound failed because " +
        "the position went out of range during the Compound operation. If " +
        "that is the case, either the next rebalance or the next " +
        "check-interval will compound the fees \u2014 no need to worry.",
    });
    /*-
     *  The failed compound may have paid gas: a cancel, or a failed
     *  swap's approvals, reverted swaps and cancels.
     */
    await recordSpentGas(spentGasOf(err), deps, _actualGasCostUsd);
  } finally {
    emit({ compoundInProgress: false });
    if (release) release();
    if (lock)
      log.info("[bot] Compound lock released for #%s", position.tokenId);
  }
}

/**
 * Handle a manual forceCompound request (works regardless of range).
 * @returns {Promise<boolean>} true if executeCompound ran this cycle.
 */
async function handleForceCompound(
  deps,
  poolState,
  ethersLib,
  position,
  provider,
  refreshPosition,
) {
  if (!deps._botState?.forceCompound) return false;
  const feesUsd = deps._lastUnclaimedFeesUsd || 0;
  log.info(
    "[bot] Manual compound requested — compounding… NFT #%s (fees $%s)",
    position.tokenId,
    feesUsd.toFixed(2),
  );
  await executeCompound(deps, poolState, ethersLib, "manual");
  await refreshPosition(position, ethersLib, provider);
  return true;
}

module.exports = {
  checkCompound,
  recordCompound,
  executeCompound,
  handleForceCompound,
  _freshFeesUsd, // exported for tests
  _compoundMessage, // exported for tests
};
