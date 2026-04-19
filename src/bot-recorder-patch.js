/**
 * @file bot-recorder-patch.js
 * @description Builder for the bot-state update patch emitted by a
 *   successful rebalance.  Extracted from bot-recorder.js for
 *   line-count compliance.  Produces the object that gets passed to
 *   `updateBotState` so the dashboard sees the new pnlSnapshot reset,
 *   HODL baseline, rangeRounded warning, and residualWarning warning.
 */

"use strict";

/**
 * Build the bot-state update patch for a successful rebalance.
 *
 * @param {object} deps     Bot-cycle dependencies (uses `_botState`).
 * @param {object} result   Rebalance result from `executeRebalance`.
 * @param {string} mintNow  ISO timestamp of the mint, used for
 *                          `positionMintDate`/`positionMintTimestamp`
 *                          and as the `at` stamp on `residualWarning`.
 * @returns {object} Patch object.
 */
function buildUpdatePatch(deps, result, mintNow) {
  /*- Intentionally no `swapSources` on the position-state patch: the
   *  Mission Control routing badge always reverts to the hard-coded
   *  default "9mm Aggregator" after a rebalance completes. Per-rebalance
   *  route info still lives on each row in the Rebalance Events table
   *  (written by bot-recorder.js to rebalance_log.json / pool-scanner
   *  cache), which is the correct place for historical detail. */
  const patch = {
    oorSince: null,
    positionMintDate: mintNow.slice(0, 10),
    positionMintTimestamp: mintNow,
    pnlSnapshot: null,
    hodlBaseline: deps._botState?.hodlBaseline || null,
  };
  if (
    result.requestedRangePct &&
    result.effectiveRangePct &&
    Math.abs(result.effectiveRangePct - result.requestedRangePct) > 0.01
  )
    patch.rangeRounded = {
      requested: result.requestedRangePct,
      effective: result.effectiveRangePct,
    };
  if (result.residualWarning)
    patch.residualWarning = { ...result.residualWarning, at: mintNow };
  return patch;
}

module.exports = { buildUpdatePatch };
