/**
 * @file src/bot-cycle-opts.js
 * @module bot-cycle-opts
 * @description
 * Builder for the opts bag passed to `executeRebalance` from
 * `_executeAndRecord` in `bot-cycle.js`.  Extracted out of bot-cycle
 * for line-count compliance (and so the
 * `feedback_one_literal_per_shipped_default` baseline read sits next
 * to its only consumer rather than at the top of a 600-line file).
 */

"use strict";

const config = require("./config");
const { getTokenSymbol } = require("./server-scan");
const { loadShippedDefaults } = require("./load-merged-defaults");

/*- Shipped defaults for the per-position config fallbacks below.  Per
 *  feedback_one_literal_per_shipped_default, the literals live only
 *  in bot-config-defaults.json. */
const _DEFAULTS = loadShippedDefaults("bot-config-defaults.json");

/**
 * Build the opts bag for `executeRebalance`.
 *
 * @param {object} deps   Bot loop deps (position, signer, _getConfig, etc.)
 * @param {object} _state Per-position bot state — no longer read here for
 *   the range-width override (was `state.customRangeWidthPct` on the
 *   one-shot code path; is now the persistent per-position config key
 *   `rebalanceRangeWidthPct` read via `deps._getConfig`).  Kept in the
 *   signature so callers don't need updating.
 * @returns {object} Options ready to pass to `executeRebalance`.
 */
function buildRebalanceOpts(deps, _state) {
  const { position } = deps;
  /*- Persistent per-position override; empty ⇒ rebalancer falls back to
   *  `rangeMath.preserveRange()` (its existing default).  Truthy check
   *  correctly omits the key for `undefined`, `null`, or `0` — all of
   *  which mean "no override". */
  const crw = deps._getConfig?.("rebalanceRangeWidthPct");
  return {
    position,
    factoryAddress: config.FACTORY,
    positionManagerAddress: config.POSITION_MANAGER,
    swapRouterAddress: config.SWAP_ROUTER,
    slippagePct: deps._getConfig?.("slippagePct") ?? config.SLIPPAGE_PCT,
    symbol0: getTokenSymbol(position.token0),
    symbol1: getTokenSymbol(position.token1),
    ...(crw ? { customRangeWidthPct: crw } : {}),
    offsetToken0Pct:
      deps._getConfig?.("offsetToken0Pct") ?? _DEFAULTS.offsetToken0Pct,
    approvalMultiple:
      deps._getConfig?.("approvalMultiple") ?? _DEFAULTS.approvalMultiple,
    gasFeePct: deps._getConfig?.("gasFeePct"),
  };
}

module.exports = { buildRebalanceOpts };
