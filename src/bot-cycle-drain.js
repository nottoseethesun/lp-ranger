/**
 * @file src/bot-cycle-drain.js
 * @module bot-cycle-drain
 * @description
 * Drained-position retirement logic — extracted from bot-cycle.js to
 * keep that file under the 500-line ESLint limit.  When a managed
 * NFT sits at 0 liquidity with no rebalance in flight for longer
 * than `DRAINED_RETIRE_MS`, the bot loop auto-retires the position
 * (status 'running' → 'stopped').  NFTs are NEVER burned — this is
 * a pure software state flip and the user can re-manage the same
 * NFT from the dashboard at any time.
 */

"use strict";

const { log } = require("./log");
const { getTokenSymbol } = require("./server-scan");
const { notify } = require("./telegram-notifications/telegram");

/**
 * How long a managed position may sit at 0 liquidity (with no rebalance
 * in flight) before auto-retirement.  Time-based (not poll-count-based)
 * so it stays predictable regardless of CHECK_INTERVAL_SEC overrides.
 */
const DRAINED_RETIRE_MS = 30 * 60_000;

/** Build a position descriptor for Telegram notifications. */
function _notifyPos(position) {
  return {
    tokenId: position.tokenId,
    token0Symbol: getTokenSymbol(position.token0),
    token1Symbol: getTokenSymbol(position.token1),
  };
}

/**
 * Check whether the position has 0 liquidity and decide what the
 * poll cycle should do about it.  Returns an early-return object
 * for the poll loop, or `null` to let pollCycle proceed normally.
 *
 * Outcomes:
 *   - Position has liquidity and retirement timer was armed → clear
 *     the timer, return `null` (proceed normally).
 *   - Drained + rebalance in flight → don't arm/advance the timer
 *     (an in-flight rebalance briefly shows 0 liquidity between
 *     removeLiquidity and mint); return `{ rebalanced: false }`.
 *   - Drained + no rebalance in flight + `forceRebalance` → `null`
 *     so the rebalance pipeline runs on the drained NFT.
 *   - Drained + no rebalance in flight + `rebalanceFailedMidway` →
 *     `null` so the midway-recovery path runs.
 *   - Drained + no rebalance in flight + timer not yet elapsed →
 *     arm or advance the timer, return `{ rebalanced: false }`.
 *   - Drained + no rebalance in flight + timer elapsed → fire a
 *     Telegram notification and return `{ rebalanced: false, retired: true }`.
 *
 * @param {object} deps  Pollcycle deps (uses `position` and `_botState`).
 * @returns {object|null}
 */
function checkZeroLiquidity(deps) {
  const { position } = deps;
  const state = deps._botState || {};
  const drained = BigInt(position.liquidity || 0) === 0n;
  /*- Re-open-failure retire is handled DIRECTLY by bot-loop.js's
   *  `_handleError` via `setTimeout(_handleRetire, GUARANTEED_DASHBOARD_HAS_POLLED_MS)`.
   *  No drain.js branch for `_retireImmediately` — an earlier defense-in-
   *  depth flag was fired by drain.js BEFORE the setTimeout could elapse
   *  (drain.js runs from the scan-completion pollCycle, within ~2 s of
   *  the failure), preempting the dashboard-poll window.  Removed.  */
  /*- `rebalanceFailedMidway` flags a "needs mint retry from wallet"
   *  state.  When the bot is also `rebalancePaused` (slippage abort —
   *  the rebalance has been ABORTED, not "paused" per the user-facing
   *  taxonomy; see [[feedback_paused_vs_aborted]]), no automatic retry
   *  will fire (the gate in `_checkRebalanceGates` blocks at paused).
   *  Treat aborted-drained as equivalent to pristine-drained for drain-
   *  timer purposes so the 30-min auto-retire safety net still fires;
   *  user must adjust Slippage or click Manage to retry before then. */
  const midwayFail = !!state.rebalanceFailedMidway && !state.rebalancePaused;
  const now = Date.now();
  if (!drained && state.drainedSince) state.drainedSince = null;
  if (drained && !state.forceRebalance && !midwayFail) {
    if (!state.rebalanceInProgress) {
      if (!state.drainedSince) state.drainedSince = now;
      const elapsedMs = now - state.drainedSince;
      log.info(
        "[bot] Position closed (0 liquidity) — drained for %ds (retires at %ds)",
        Math.round(elapsedMs / 1000),
        Math.round(DRAINED_RETIRE_MS / 1000),
      );
      if (elapsedMs >= DRAINED_RETIRE_MS) {
        const mins = Math.round(elapsedMs / 60_000);
        log.info(
          "[bot] Auto-retiring drained position #%s after ~%dm",
          position.tokenId,
          mins,
        );
        notify("positionRetired", {
          position: _notifyPos(position),
          message:
            "Position drained — auto-stopped after " +
            mins +
            " minutes at 0 liquidity. NFT is not burned; re-manage from the dashboard to resume.",
        });
        return { rebalanced: false, retired: true, drainedForMs: elapsedMs };
      }
    } else {
      log.info(
        "[bot] Position closed (0 liquidity) — rebalance in progress, retirement timer paused",
      );
    }
    return { rebalanced: false };
  }
  if (midwayFail) {
    log.info(
      "[bot] Mid-rebalance recovery: 0 liquidity, retrying mint from wallet balances",
    );
  }
  return null;
}

/**
 * True when the position is in the "aborted-and-drained" terminal
 * state: a prior rebalance failed (e.g., slippage), leaving wallet
 * tokens + 0 NFT liquidity, and `rebalancePaused` is set so the gate
 * in `_checkRebalanceGates` will block any retry until the user
 * adjusts Slippage or clicks Manage.  Used by `pollCycle` to skip
 * pool-state / pnl / Moralis work for the duration of this state —
 * none of those resolution paths require fresh data.
 *
 * @param {object} deps  pollCycle deps (uses `position`, `_botState`).
 * @returns {boolean}
 */
function isAbortedDrained(deps) {
  const drained = BigInt(deps.position.liquidity || 0) === 0n;
  if (!drained || deps._botState?.forceRebalance) return false;
  /*- User-aborted (paused awaiting user action).  Short-circuit
   *  pollCycle: no pool-state read, no pnl computation, no Moralis
   *  fetches — just advance the drain timer via checkZeroLiquidity.
   *  Re-open failures retire via bot-loop.js's setTimeout, not via
   *  drain.js, so no extra flag needed here. */
  return !!deps._botState?.rebalancePaused;
}

module.exports = {
  checkZeroLiquidity,
  isAbortedDrained,
  DRAINED_RETIRE_MS,
};
