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

const { getTokenSymbol } = require("./server-scan");
const { notify } = require("./telegram");

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
  const midwayFail = !!state.rebalanceFailedMidway;
  const now = Date.now();
  if (!drained && state.drainedSince) state.drainedSince = null;
  if (drained && !state.forceRebalance && !midwayFail) {
    if (!state.rebalanceInProgress) {
      if (!state.drainedSince) state.drainedSince = now;
      const elapsedMs = now - state.drainedSince;
      console.log(
        "[bot] Position closed (0 liquidity) — drained for %ds (retires at %ds)",
        Math.round(elapsedMs / 1000),
        Math.round(DRAINED_RETIRE_MS / 1000),
      );
      if (elapsedMs >= DRAINED_RETIRE_MS) {
        const mins = Math.round(elapsedMs / 60_000);
        console.log(
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
      console.log(
        "[bot] Position closed (0 liquidity) — rebalance in progress, retirement timer paused",
      );
    }
    return { rebalanced: false };
  }
  if (midwayFail) {
    console.log(
      "[bot] Mid-rebalance recovery: 0 liquidity, retrying mint from wallet balances",
    );
  }
  return null;
}

module.exports = {
  checkZeroLiquidity,
  DRAINED_RETIRE_MS,
};
