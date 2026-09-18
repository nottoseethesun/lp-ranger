/**
 * @file bot-cycle-compound.js
 * @description Compound execution, recording, and throttle logic for the
 *   bot poll cycle. Split from bot-cycle.js for line-count compliance.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const {
  actualGasCostUsd: _actualGasCostUsd,
  fetchTokenPrices,
} = require("./bot-pnl-updater");
const { notify } = require("./telegram-notifications/telegram");
const { getTokenSymbol } = require("./server-scan");
const { executeCompound: runCompound } = require("./compounder");
const {
  withFreshPricesAllowed,
  invalidatePriceCacheFor,
} = require("./price-fetcher");
const { loadShippedDefaults } = require("./load-merged-defaults");
const { hasCompoundedTotal } = require("./bot-config-keys");

/*- Shipped default for the approvalMultiple per-position config
 *  fallback below.  Per feedback_one_literal_per_shipped_default, the
 *  literal lives only in bot-config-defaults.json. */
const _DEFAULTS = loadShippedDefaults("bot-config-defaults.json");

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
  /*- Reload / initial-scan window: skip auto-compound while a scan is
   *  running so the compound doesn't race the state reconstruction.
   *  Manual (`forced === true`) compounds still bypass. */
  if (!forced && botSt._scanRunning) return false;

  // Auto-compound throttle: max(5 × checkInterval, 300 s floor).
  // config.CHECK_INTERVAL_SEC is sourced from the shipped JSON via
  // src/config.js — guaranteed defined, no defensive fallback needed.
  // The 300 s floor is a hardcoded throttle minimum (not a shipped
  // config default that's tunable); it sets a lower bound on how
  // often auto-compound can fire regardless of how aggressive the
  // operator sets checkIntervalSec.
  const lastAt = _gc("lastCompoundAt");
  if (!forced && lastAt) {
    const interval = Math.max(config.CHECK_INTERVAL_SEC * 5, 300) * 1000;
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
 * @param {number} dep0  Token0 coins this compound re-deposited.
 * @param {number} dep1  Token1 coins this compound re-deposited.
 * @returns {{compoundedAmount0: number, compoundedAmount1: number}|null}
 */
function _compoundedTotalFields(saved0, saved1, dep0, dep1) {
  if (!hasCompoundedTotal(saved0, saved1)) return null;
  /*- Falsy-fallback is wanted here, not `??`. Either side alone
   *  establishes the total, so the other may still be absent or NaN, and
   *  `??` would carry a NaN straight into the sum. A saved zero is
   *  unaffected: both forms leave it at zero. */
  return {
    compoundedAmount0: (saved0 || 0) + dep0,
    compoundedAmount1: (saved1 || 0) + dep1,
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

/** Record a successful compound: update history, P&L tracker gas, collected fees. */
async function recordCompound(deps, result) {
  const emit = deps.updateBotState || (() => {});
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const gasWei = BigInt(result.gasCostWei || 0);
  const gasCostUsd = gasWei > 0n ? await _actualGasCostUsd(gasWei) : 0;
  const history = _gc("compoundHistory") || [];
  /*-
   *  tokenId is required so the Managed Current panel can filter
   *  compoundHistory to the current NFT (matching the Unmanaged scan).
   *  Without it, `bot-pnl-updater._currentNftCompounded` would skip live
   *  entries and the row would underreport.
   */
  history.push({
    timestamp: result.timestamp,
    txHash: result.depositTxHash,
    tokenId: deps.position?.tokenId ? String(deps.position.tokenId) : undefined,
    amount0Deposited: result.amount0Deposited,
    amount1Deposited: result.amount1Deposited,
    usdValue: result.usdValue,
    price0: result.price0,
    price1: result.price1,
    gasCostUsd,
    trigger: result.trigger,
  });
  const dep0 = result.depositedAmount0 || 0;
  const dep1 = result.depositedAmount1 || 0;
  const totals = _compoundedTotalFields(
    _gc("compoundedAmount0"),
    _gc("compoundedAmount1"),
    dep0,
    dep1,
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
  _logCompound(result, gasCostUsd, totals, dep0, dep1);
}

/*-
 *  Show both numbers so users can see the residual: collected = full
 *  Collect output; reinvested = what fit the current tick ratio and was
 *  actually re-deposited.  The remainder stays in the wallet as residual
 *  (tracked by residual-tracker.js) and is NOT counted as compounded.
 *
 *  "lifetime" is this pool's cumulative compounded coins across every
 *  NFT in the rebalance chain, reported in coins because coins are what
 *  is saved; their dollar value belongs to whichever poll displays it.
 */
function _logCompound(result, gasCostUsd, totals, dep0, dep1) {
  const collectedUsd = result.collectedUsd ?? result.usdValue;
  const residualUsd = Math.max(0, collectedUsd - result.usdValue);
  const trig = result.trigger === "manual" ? "manual" : "auto";
  log.info("[bot] Compound source: standalone %s Compound op", trig);
  log.info("[bot]   Method: collect fees + increaseLiquidity on the same NFT");
  log.info("[bot]   Reinvested portion is added to lifetime compounded total");
  log.info(
    "[bot] Compound complete: collected $%s reinvested $%s residual $%s",
    collectedUsd.toFixed(2),
    result.usdValue.toFixed(2),
    residualUsd.toFixed(2),
  );
  log.info(
    "[bot]   gas $%s | lifetime compounded %s",
    gasCostUsd.toFixed(4),
    _lifetimeCoinsText(totals, dep0, dep1),
  );
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
 * @param {number} dep0  Token0 coins this compound re-deposited.
 * @param {number} dep1  Token1 coins this compound re-deposited.
 * @returns {string}
 */
function _lifetimeCoinsText(totals, dep0, dep1) {
  if (totals === null)
    return (
      "awaiting the chain scan (this compound: " +
      dep0.toFixed(6) +
      "/" +
      dep1.toFixed(6) +
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
    slippagePct: deps._getConfig?.("slippagePct") ?? config.SLIPPAGE_PCT,
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
    botSt.forceCompound = false;
    emit({ compoundInProgress: true });

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
        message: `Compounded $${(result.usdValue || 0).toFixed(2)} in fees`,
      });
    } else {
      log.info("[bot] Compound skipped: %s", result.reason);
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
};
