/**
 * @file src/bot-cycle.js
 * @module bot-cycle
 * @description
 * Poll cycle, execution, gates, and private key resolution.  Extracted
 * from bot-loop.js.  (Config reload + the OOR trigger predicates live
 * in src/bot-cycle-triggers.js.)
 */

"use strict";
const ethers = require("ethers");
const config = require("./config");
const { buildRebalanceOpts } = require("./bot-cycle-opts");
const {
  _isTimeoutExpired,
  _isBeyondThreshold,
} = require("./bot-cycle-triggers");
// key-store is retained for api-key-store.js; no longer used here directly.
const { emojiId, logCtx } = require("./logger");
const { log } = require("./log");
const {
  getPoolState,
  executeRebalance,
  enrichResultUsd,
} = require("./rebalancer");
const { getTokenSymbol } = require("./server-scan");
const { notify } = require("./telegram-notifications/telegram");
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
  estimateGasCostUsd: _estimateGasCostUsd,
  actualGasCostUsd: _actualGasCostUsd,
  updatePnlAndStats: _updatePnlAndStats,
} = require("./bot-pnl-updater");
const {
  appendLog,
  _closePnlEpoch,
  _recordResidual,
  _applyRebalanceResult,
  _activePosSummary,
} = require("./bot-recorder");
const { PM_ABI } = require("./pm-abi");
const {
  checkCompound: _checkCompound,
  handleForceCompound: _handleForceCompound,
} = require("./bot-cycle-compound");
const {
  checkZeroLiquidity: _checkZeroLiquidity,
  isAbortedDrained: _isAbortedDrained,
  DRAINED_RETIRE_MS,
} = require("./bot-cycle-drain");
const {
  checkResidualCleanup: _checkResidualCleanup,
  classifyTrigger: _classifyTrigger,
  triggerReason: _triggerReason,
  updateCleanupState: _updateCleanupState,
  computeWalletResidualUsd: _computeWalletResidualUsd,
} = require("./bot-cycle-residual");
const {
  _activateSwapBackoff,
  _checkSwapBackoff,
} = require("./bot-cycle-backoff");
const {
  withFreshPricesAllowed,
  invalidatePriceCacheFor,
} = require("./price-fetcher");

/** Build a position descriptor for Telegram notifications. Carries the
 *  fields `buildHeader()` in `telegram-notifications/telegram.js` reads:
 *  `tokenId` (Position line), `fee` (Fee Tier line), and `token0`/`token1`
 *  (drive the symbol-pair lines via the cache fallback chain).  The
 *  pre-resolved `*Symbol` fields short-circuit that fallback when the
 *  cache hasn't been warmed yet (e.g. fresh otherError early in startup). */
function _notifyPos(position) {
  return {
    tokenId: position.tokenId,
    fee: position.fee,
    token0: position.token0,
    token1: position.token1,
    token0Symbol: getTokenSymbol(position.token0),
    token1Symbol: getTokenSymbol(position.token1),
  };
}

/*- Canonical 6-field log context for rebalance entry-point logs.  Used
 *  by both `_prepareRebalance` and `_handleRebalanceSuccess` so the
 *  field set is built in one place — see [[feedback-log-full-context]]. */
function _rebalanceCtx(deps, position) {
  return logCtx({
    chain: config.CHAIN_NAME,
    wallet: deps.address,
    factory: config.POSITION_MANAGER,
    tokenId: position.tokenId,
    symbol0: getTokenSymbol(position.token0),
    symbol1: getTokenSymbol(position.token1),
  });
}

/** Acquire lock, log reason, and prepare state for rebalance. */
async function _prepareRebalance(deps) {
  const { position } = deps;
  const trigger = _classifyTrigger(deps._botState);
  log.info(
    "[rebalance] %s: %s — rebalancing…",
    _rebalanceCtx(deps, position),
    _triggerReason(trigger),
  );
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  if (lock)
    log.info(
      "[bot] Rebalance lock acquired for #%s (pending: %d)",
      position.tokenId,
      lock.pending(),
    );
  const state = deps._botState || {};
  state.rebalanceInProgress = true;
  state.forceRebalance = false;
  return { release, state, trigger };
}

/** Handle all post-rebalance bookkeeping on success. */
async function _handleRebalanceSuccess(deps, result, state, throttle, pos) {
  state.swapBackoffMs = 0;
  state.swapBackoffUntil = 0;
  state.swapBackoffAttempts = 0;
  _updateCleanupState(state, result.trigger, deps.updateBotState);
  throttle.recordRebalance();
  if (deps._recordPoolRebalance && deps._poolKey) {
    const pk = deps._poolKey(pos.token0, pos.token1, pos.fee);
    deps._recordPoolRebalance(pk);
    log.info(
      "[bot] Recorded pool rebalance: %s (daily=%d)",
      pk,
      throttle.getState().dailyCount,
    );
  } else {
    log.warn(
      "[bot] Pool rebalance NOT recorded: _recordPoolRebalance=%s _poolKey=%s",
      !!deps._recordPoolRebalance,
      !!deps._poolKey,
    );
  }
  try {
    await enrichResultUsd(
      result,
      () => _fetchTokenPrices(pos.token0, pos.token1),
      pos.token0,
      pos.token1,
    );
  } catch (_) {
    /* prices unavailable */
  }
  _recordResidual(deps, result);
  /*- Enrich the residualWarning payload with the total tracked wallet
   *  residual USD (the same number the Lifetime panel shows) so the
   *  post-rebalance dialog can display it as the primary "Residual value"
   *  figure.  `imbalanceUsd` (the corrective-swap loop's last uncorrected
   *  swap amount) is kept on the payload as supporting technical detail. */
  if (result.residualWarning)
    result.residualWarning.walletResidualUsd = await _computeWalletResidualUsd(
      deps,
      result,
      pos.token0,
      pos.token1,
    );
  appendLog(result);
  log.info(
    "[rebalance] %s: Rebalance OK — new tokenId: #%s %s",
    _rebalanceCtx(deps, pos),
    String(result.newTokenId),
    emojiId(String(result.newTokenId)),
  );
  notify("rebalanceSuccess", {
    position: _notifyPos(pos),
    message: `New NFT #${result.newTokenId}`,
    txHash: result.txHashes?.mint,
  });
  await _closePnlEpoch(deps, result);
  _applyRebalanceResult(deps, result);
  if (deps._botState?._triggerScan) deps._botState._triggerScan();
}

async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle } = deps;
  const { release, state, trigger } = await _prepareRebalance(deps);
  try {
    /*- Re-open detection: if the position is at zero liquidity when the
     *  rebalance starts, this attempt is a re-open of a previously
     *  retired position (user clicked Manage on a closed NFT, OR
     *  manual force-rebalance on a drained position).  Any rebalance
     *  failure should revert the position immediately to the
     *  closed/auto-retired state rather than leaving it in a 30-min
     *  drain-timer limbo (the user's directive: "put it back where it
     *  was when the Manage button was clicked in the first place").
     *  Flag is consumed in bot-loop.js's `_handleError`. */
    state._rebalanceStartedDrained = BigInt(position.liquidity || 0) === 0n;
    const result = await executeRebalance(
      signer,
      ethersLib,
      buildRebalanceOpts(deps, state),
    );
    // Stamp the trigger onto the result so downstream (logs, events,
    // Activity Log) can render the correct cause.
    result.trigger = trigger;
    // Price moved too fast — tokens are removed+swapped but not minted.
    // Activate exponential backoff so the next poll cycle waits before
    // retrying.  Tokens sit safely in the wallet until the next attempt.
    if (result.priceVolatile) {
      _activateSwapBackoff(state, deps.updateBotState);
      return { rebalanced: false, priceVolatile: true, trigger };
    }
    if (result.success) {
      await _handleRebalanceSuccess(deps, result, state, throttle, position);
    } else {
      log.error("[bot] Rebalance failed:", result.error);
      notify("rebalanceFail", {
        position: _notifyPos(position),
        error: result.error,
      });
      if (result.cancelled) {
        log.warn(
          "[bot] TX was auto-cancelled (nonce freed). Cancel TX: %s",
          result.cancelTxHash || "unknown",
        );
        notify("otherError", {
          position: _notifyPos(position),
          error: "TX auto-cancelled (stuck nonce freed)",
          txHash: result.cancelTxHash,
        });
        if (deps.updateBotState)
          deps.updateBotState({
            txCancelled: {
              message: result.error,
              cancelTxHash: result.cancelTxHash,
              at: new Date().toISOString(),
            },
          });
        await _recordCancelGas(result, deps);
      }
    }
    state.rebalanceInProgress = false;
    /*- Clear the yellow "residual cleanup" banner on failure too; a failed
     *  cleanup should not leave the UI stuck in that state.  residualCleanupUsed
     *  is NOT set here — failures don't consume the cleanup opportunity. */
    if (!result.success && state.residualCleanupInProgress) {
      state.residualCleanupInProgress = false;
      if (deps.updateBotState)
        deps.updateBotState({ residualCleanupInProgress: false });
    }
    return {
      rebalanced: result.success,
      error: result.error,
      cancelled: result.cancelled,
      newTokenId: result.newTokenId,
      oldTokenId: result.oldTokenId,
      txHashes: result.txHashes,
      blockNumber: result.blockNumber,
      swapSources: result.swapSources,
      trigger,
    };
  } finally {
    if (release) {
      release();
      log.info("[bot] Rebalance lock released for #%s", position.tokenId);
    }
  }
}

/** Record cancel TX gas in the P&L tracker when a rebalance is cancelled. */
async function _recordCancelGas(result, deps) {
  if (!result.cancelGasCostWei || result.cancelGasCostWei <= 0n) return;
  if (!deps._pnlTracker) return;
  const gasUsd = await _actualGasCostUsd(result.cancelGasCostWei);
  const gasNative = Number(result.cancelGasCostWei) / 1e18;
  if (gasUsd > 0) deps._pnlTracker.addGas(gasUsd, gasNative);
}

/** Check if estimated gas cost exceeds 0.5% of position value. */
async function _isGasTooHigh(provider, position, poolState) {
  try {
    const gasCost = await _estimateGasCostUsd(provider);
    const prices = await _fetchTokenPrices(position.token0, position.token1);
    const posValue = _positionValueUsd(
      position,
      poolState,
      prices.price0,
      prices.price1,
    );
    if (posValue > 0 && gasCost > 0 && gasCost / posValue > 0.005) {
      log.warn(
        "[bot] Gas too high: $%s is %s%% of position ($%s) — deferring",
        gasCost.toFixed(4),
        ((gasCost / posValue) * 100).toFixed(2),
        posValue.toFixed(2),
      );
      return true;
    }
  } catch (_) {
    /* proceed if gas check fails */
  }
  return false;
}

/** Check range, threshold, and OOR timeout.  Returns early result or null. */
function _checkRangeAndThreshold(deps, poolState, emit) {
  const { position } = deps;
  const forced = !!deps._botState?.forceRebalance;
  const botSt = deps._botState || {};
  const inRange =
    poolState.tick >= position.tickLower && poolState.tick < position.tickUpper;
  if (inRange && !forced) {
    if (botSt.oorSince) {
      botSt.oorSince = null;
      emit({ oorSince: null });
    }
    return { rebalanced: false, inRange: true };
  }
  const gc = deps._getConfig;
  const beyondThreshold = forced || _isBeyondThreshold(poolState, position, gc);
  if (!beyondThreshold) {
    if (!botSt.oorSince) {
      botSt.oorSince = Date.now();
      emit({ oorSince: botSt.oorSince });
    }
    if (!_isTimeoutExpired(botSt, gc)) {
      emit({ withinThreshold: true });
      return { rebalanced: false, withinThreshold: true };
    }
    log.info("[bot] OOR timeout expired — triggering rebalance");
    notify("oorTimeout", {
      position: _notifyPos(deps.position),
      message: "Position has been out of range beyond the configured timeout.",
    });
  } else if (!forced && !botSt.oorSince) {
    botSt.oorSince = Date.now();
    emit({ oorSince: botSt.oorSince });
  }
  emit({ withinThreshold: false });
  return null;
}

/** Rewrite low-level RPC errors into user-readable messages. */
function _humanizeError(msg) {
  if (/insufficient funds|INSUFFICIENT_FUNDS/i.test(msg))
    return "Wallet has insufficient gas to send transactions. Send native tokens (e.g. PLS) to the wallet and retry.";
  return msg;
}

/*- Bot-state gates checked before any throttle/pool/gas logic.  Every
 *  early-return here means the bot state itself vetoes the rebalance,
 *  so the throttle counters must NOT tick.  Extracted to keep
 *  `_checkRebalanceGates` under the cyclomatic-complexity cap. */
function _checkStateGates(deps, forced) {
  const st = deps._botState;
  if (!forced && st?.rebalancePaused)
    return { rebalanced: false, paused: true };
  /*- Reload / initial-scan window: while `_triggerScan` is running the
   *  position's on-chain-derived state (compound history, HODL
   *  baseline, epochs) is being rebuilt from scratch.  An auto-rebalance
   *  fired mid-scan would race the reconstruction and re-corrupt the
   *  very numbers the reload is trying to fix.  Uses `_scanRunning` (an
   *  existing bot-loop flag) rather than a bespoke "reloading" flag.
   *  Manual (`forced === true`) rebalances still bypass — user is on
   *  their own if they click Rebalance mid-scan. */
  if (!forced && st?._scanRunning)
    return { rebalanced: false, scanRunning: true };
  return null;
}

/** Check throttle, daily cap, dry-run, and gas before executing.  Returns early result or null. */
function _checkRebalanceGates(deps, poolState, forced) {
  const { throttle, dryRun } = deps;
  const stateGate = _checkStateGates(deps, forced);
  if (stateGate) return stateGate;
  const backoff = _checkSwapBackoff(deps, forced);
  if (backoff) return backoff;
  const can = !forced && throttle.canRebalance();
  if (can && !can.allowed) {
    log.info(
      `[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`,
    );
    /*- No throttleState emit here: the unconditional top-of-pollCycle
     *  emit already published this cycle's snapshot. */
    return { rebalanced: false };
  }
  if (!forced && deps._canRebalancePool && deps._poolKey) {
    const pk = deps._poolKey(
      deps.position.token0,
      deps.position.token1,
      deps.position.fee,
    );
    const max =
      deps.throttle.getState().dailyMax || config.MAX_REBALANCES_PER_DAY;
    if (!deps._canRebalancePool(pk, max)) {
      log.info(
        "[bot] OOR but pool daily cap reached (%d/%d) — deferring",
        max,
        max,
      );
      return { rebalanced: false };
    }
  }
  if (dryRun) {
    log.info(
      "[bot] DRY RUN — OOR, tick=%d range=[%d,%d]",
      poolState.tick,
      deps.position.tickLower,
      deps.position.tickUpper,
    );
    return { rebalanced: false };
  }
  return null;
}

/**
 * Refresh position liquidity + ticks from chain.
 * Keeps the in-memory position object current after
 * rebalance mints a new NFT or external changes.
 */
async function _refreshPosition(position, ethersLib, provider) {
  try {
    const pm = new ethersLib.Contract(
      config.POSITION_MANAGER,
      PM_ABI,
      provider,
    );
    const d = await pm.positions(position.tokenId);
    position.liquidity = String(d.liquidity);
    if (d.tickLower !== undefined) position.tickLower = Number(d.tickLower);
    if (d.tickUpper !== undefined) position.tickUpper = Number(d.tickUpper);
  } catch (err) {
    log.warn(
      "[bot] _refreshPosition failed for #%s: %s",
      position.tokenId,
      err.message,
    );
  }
}

/*-
 * True when two liquidity readings differ.  `null`/`undefined` normalise
 * to `"0"` explicitly (not via the `x || 0` type-conversion trick, per the
 * "Type Checks" rule in CLAUDE-BEST-PRACTICES.md) so a first-poll snapshot
 * of an uninitialised position doesn't spuriously trigger the emit.  Used
 * to gate the pollCycle `activePosition` re-emit so a chain-observed drain
 * (or re-mint) propagates to the dashboard on the next `/api/status` poll
 * — see the fix for the "Open Positions badge stale on failed rebalance"
 * bug.
 */
function _liquidityChanged(prev, cur) {
  const p = prev !== undefined && prev !== null ? String(prev) : "0";
  const c = cur !== undefined && cur !== null ? String(cur) : "0";
  return p !== c;
}

/**
 * Check whether a compound should be triggered (manual or auto).
 * Runs after P&L update so unclaimed fees are fresh.
 * @param {object} deps  Bot deps (including _botState, _getConfig).
 * @param {object} poolState  Current pool state.
 * @param {object} ethersLib  ethers module.
 */
/**
 * Run the range-check → gate → gas-check → execute path after the
 * poll-cycle's pnl + cleanup-detection steps have finished.  Extracted
 * to keep `pollCycle` under the complexity cap.
 */
async function _runRangeAndExec(deps, ethersLib, poolState, emit, compounded) {
  const rangeCheck = _checkRangeAndThreshold(deps, poolState, emit);
  if (rangeCheck) {
    const autoCompounded = await _checkCompound(
      deps,
      poolState,
      ethersLib,
      _refreshPosition,
    );
    if (compounded || autoCompounded) rangeCheck.compounded = true;
    return rangeCheck;
  }
  /*- Residual-cleanup rebalances use `forceRebalance` to pass the range
   *  check (so they can run when in range) but must still respect all
   *  throttle / pause / daily-cap / dry-run gates per user spec.  Treat
   *  a cleanup-in-progress rebalance as NOT user-forced for gate purposes. */
  const cleanup = !!deps._botState?.residualCleanupInProgress;
  const forced = !!deps._botState?.forceRebalance && !cleanup;
  if (config.VERBOSE)
    log.info(
      "[bot] pollCycle: OOR on #%s, forced=%s, cleanup=%s, tick=%d range=[%d,%d]",
      deps.position.tokenId,
      forced,
      cleanup,
      poolState.tick,
      deps.position.tickLower,
      deps.position.tickUpper,
    );
  const gate = _checkRebalanceGates(deps, poolState, forced);
  if (gate) {
    if (compounded) gate.compounded = true;
    return gate;
  }
  if (await _isGasTooHigh(deps.provider, deps.position, poolState)) {
    const r = { rebalanced: false, gasDeferred: true };
    if (compounded) r.compounded = true;
    return r;
  }
  /*- Idle-driven price-lookup pause: drop cached prices for this
   *  position's tokens and run the move under `withFreshPricesAllowed`
   *  so every downstream price fetch (swap-gates, rebalancer-execute,
   *  rebalancer-correct, bot-pnl-updater, dust) bypasses the pause flag
   *  and the cache TTL.  Counter is decremented in `finally` so a
   *  thrown error still restores the prior pause state. */
  invalidatePriceCacheFor([
    { token: deps.position.token0 },
    { token: deps.position.token1 },
  ]);
  const execResult = await withFreshPricesAllowed(() =>
    _executeAndRecord(deps, ethersLib),
  );
  if (compounded) execResult.compounded = true;
  return execResult;
}

/** Single poll iteration: check range, threshold, throttle, then rebalance if needed. */
async function pollCycle(deps) {
  const { provider, position, throttle } = deps;
  const ethersLib = deps._ethersLib || ethers;
  const emit = deps.updateBotState || (() => {});
  throttle.tick();
  /*- Fresh throttle snapshot every poll.  Previously `throttleState`
   *  was emitted only at bot startup (BEFORE the first
   *  `_reloadFromConfig` applied the saved per-position
   *  minRebalanceIntervalMin), after a successful rebalance, and after
   *  a history scan — so a quiet position served a stale snapshot
   *  carrying the global default interval, and the dashboard's
   *  Doubling Trigger Window label read 4× the wrong value after a
   *  page refresh (user-reported).  bot-loop runs `_reloadFromConfig`
   *  immediately before pollCycle, so this snapshot reflects the saved
   *  config; emitting after `tick()` also surfaces doubling-expiry
   *  without waiting for the next rebalance. */
  emit({ throttleState: throttle.getState() });
  /*- Aborted-and-drained short-circuit: skip all RPC/Moralis work for
   *  positions waiting on user-event-driven resolution (Slippage
   *  change / Manage re-click) OR clock-driven retire (30 min).
   *  Drain timer still advances via checkZeroLiquidity. */
  if (_isAbortedDrained(deps)) {
    return _checkZeroLiquidity(deps) || { rebalanced: false };
  }
  let poolState;
  try {
    poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });
  } catch (err) {
    /*- pollError (not error) — a pool-state RPC failure is a polling
     *  hiccup, not a failed rebalance attempt.  Surfacing it as `error`
     *  would set firstFailureAt in bot-loop and later trigger a spurious
     *  "Position Recovered" modal on the next successful poll. */
    log.error("[bot] Pool state error:", err.message);
    return { rebalanced: false, pollError: err.message };
  }
  const prevLiquidity = position.liquidity;
  await _refreshPosition(position, ethersLib, provider);
  /*- On liquidity change (drain, external mint, rebalance-follow), re-emit
   *  activePosition so the dashboard's /api/status view refreshes.  Without
   *  this, the "Open Positions" badge and LP Position Browser stayed stale
   *  after a mid-rebalance drain until the user manually switched positions. */
  if (_liquidityChanged(prevLiquidity, position.liquidity)) {
    emit({ activePosition: _activePosSummary(position) });
  }
  const snap = await _updatePnlAndStats(deps, poolState, ethersLib);
  const zeroLiqResult = _checkZeroLiquidity(deps);
  if (zeroLiqResult) return zeroLiqResult;
  const compounded = await _handleForceCompound(
    deps,
    poolState,
    ethersLib,
    position,
    provider,
    _refreshPosition,
  );
  /*- Residual-cleanup check runs AFTER the pnl update (so `snap` has
   *  fresh residual/currentValue numbers) but BEFORE the range check, so
   *  the cleanup can fire even when the position is in range. */
  _checkResidualCleanup(deps, snap);
  if (deps._botState?.forceRebalance)
    log.info("[bot] Force rebalance requested");
  return _runRangeAndExec(deps, ethersLib, poolState, emit, compounded);
}

module.exports = {
  _executeAndRecord,
  _isGasTooHigh,
  _checkRangeAndThreshold,
  _checkZeroLiquidity,
  _humanizeError,
  _checkRebalanceGates,
  _activateSwapBackoff,
  _liquidityChanged,
  pollCycle,
  DRAINED_RETIRE_MS,
};
