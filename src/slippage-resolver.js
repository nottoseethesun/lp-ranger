/**
 * @file src/slippage-resolver.js
 * @module slippageResolver
 * @description
 * Resolve which slippage percentage applies to a given swap direction.
 *
 * Slippage is two settings, one per token, and nothing else. The rule
 * is simple: use the DESTINATION-token's value if set, otherwise the
 * shipped `slippagePct` default (currently 0.75%) — a default in
 * `bot-config-defaults.json`, not a per-position setting.
 *
 * **Every swap asks this, rebalance and compound alike.** The single
 * per-position `slippagePct` that the old Slippage row saved is
 * retired: it was dormant for rebalances and still honoured by
 * compounds, so one position could swap at two different slippages
 * depending on which move it was making.
 *
 * Destination-token rule:
 *   - A `token0 → token1` swap uses `slippagePctToken1`.
 *   - A `token1 → token0` swap uses `slippagePctToken0`.
 * Rationale: the destination-token side is where MEV can extract
 * value from the swap; that's where the slippage budget lives.
 */

"use strict";

const { loadShippedDefaults } = require("./load-merged-defaults");

/*- Shipped default read once at module init.  Used whenever the
 *  destination-side per-token value is unset. */
const _DEFAULTS = loadShippedDefaults("bot-config-defaults.json");

/** Is the given value a legal, finite number? */
function _isSet(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Resolve the slippage percent (0–5, human-readable percentage) to
 * apply to a specific swap direction, given the rebalance opts.
 *
 * @param {object} opts
 * @param {number} [opts.slippagePctToken0]  Per-token override, token 0 side.
 * @param {number} [opts.slippagePctToken1]  Per-token override, token 1 side.
 * @param {boolean} isToken0To1  Swap direction: `true` = token0 → token1
 *   (destination is token1); `false` = token1 → token0 (destination is
 *   token0).
 * @returns {number}  Slippage % to use for this swap.
 */
function resolveSlippagePct(opts, isToken0To1) {
  const dest = isToken0To1 ? opts?.slippagePctToken1 : opts?.slippagePctToken0;
  return _isSet(dest) ? dest : _DEFAULTS.slippagePct;
}

module.exports = { resolveSlippagePct };
