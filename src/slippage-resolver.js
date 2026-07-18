/**
 * @file src/slippage-resolver.js
 * @module slippageResolver
 * @description
 * Resolve which slippage percentage applies to a given swap direction.
 *
 * The dashboard's single "Slippage Tolerance" input was replaced by
 * two per-token inputs (`slippagePctToken0` / `slippagePctToken1`).
 * The rule is simple: use the DESTINATION-token's per-token value if
 * set, otherwise use the shipped `slippagePct` default (currently
 * 0.75%).  The position's legacy saved `slippagePct` is no longer
 * consulted — that field lingers in `bot-config.json` on upgrades but
 * is dormant.
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
