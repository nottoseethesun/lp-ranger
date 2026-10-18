/**
 * @file src/bot-cycle-backoff.js
 * @module bot-cycle-backoff
 * @description
 * Exponential swap-backoff helpers extracted from `bot-cycle.js`.
 *
 * When a rebalance reaches the swap step but fails because the pool price
 * moved between quote and fill (priceVolatile), the bot activates an
 * exponential backoff timer: app-runtime.json's `tx.swapBackoffBaseMs`
 * first, doubling with each failure up to `tx.swapBackoffMaxMs`.  The
 * timer is cleared on the next successful rebalance.  After
 * `REBALANCE_RETRY_SWAP_LIMIT` consecutive priceVolatile failures the bot
 * aborts with an actionable error so the user can intervene.
 *
 * These helpers are exported for `bot-cycle.js` (which orchestrates the
 * poll cycle) and unit-tested directly via `test/bot-cycle-helpers.test.js`.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");

/**
 * Activate exponential swap-backoff after a priceVolatile result.
 * Starts at `config.SWAP_BACKOFF_BASE_MS`, doubles each failure, and
 * caps at `config.SWAP_BACKOFF_MAX_MS` per wait. After
 * REBALANCE_RETRY_SWAP_LIMIT attempts, aborts with an alert.
 */
function _activateSwapBackoff(state, emit) {
  const limit = config.REBALANCE_RETRY_SWAP_LIMIT;
  const attempts = (state.swapBackoffAttempts || 0) + 1;
  state.swapBackoffAttempts = attempts;
  state.rebalanceInProgress = false;
  if (attempts >= limit) {
    state.rebalancePaused = true;
    state.rebalanceError =
      "Price moved during rebalance " +
      attempts +
      " times in a row. Market too volatile to rebalance safely. Tokens are safe in the wallet. Use manual Rebalance when ready.";
    state.swapBackoffMs = 0;
    state.swapBackoffUntil = 0;
    log.error("[bot] Max swap retries (%d) — pausing", attempts);
    if (emit)
      emit({ rebalancePaused: true, rebalanceError: state.rebalanceError });
    return;
  }
  const prev = state.swapBackoffMs || 0;
  const next = prev
    ? Math.min(prev * 2, config.SWAP_BACKOFF_MAX_MS)
    : config.SWAP_BACKOFF_BASE_MS;
  state.swapBackoffMs = next;
  state.swapBackoffUntil = Date.now() + next;
  log.warn(
    "[bot] Price volatile (attempt %d/%d) — backoff %ds",
    attempts,
    limit,
    next / 1000,
  );
}

/**
 * Check if the swap-backoff timer is active (price was too volatile on
 * the last rebalance attempt).  Returns an early result if still waiting,
 * or null to proceed.
 */
function _checkSwapBackoff(deps, forced) {
  const bs = deps._botState || {};
  if (forced || !bs.swapBackoffUntil || Date.now() >= bs.swapBackoffUntil)
    return null;
  const sec = Math.ceil((bs.swapBackoffUntil - Date.now()) / 1000);
  log.info("[bot] Swap backoff active — waiting %ds before retry", sec);
  return { rebalanced: false, swapBackoff: true };
}

module.exports = {
  _activateSwapBackoff,
  _checkSwapBackoff,
};
