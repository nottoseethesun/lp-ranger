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
const { getTokenSymbol } = require("./token-symbol-cache");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const {
  resolveRangeOverrideEnabled,
  resolveRebalanceOffsetPct,
  fullRangeSetting,
} = require("./range-override");

/** Return `{[key]: value}` if the config value is a finite number,
 *  else `{}`.  Used for optional per-position overrides, so the opts
 *  carry a key only where the position actually set one.  Readers do
 *  not depend on that: `resolveSlippagePct` asks whether the value is
 *  a finite number, so a key present and undefined reads the same as
 *  an absent one.  Keeps `buildRebalanceOpts` under the
 *  cyclomatic-complexity cap. */
function _optionalConfig(deps, key) {
  const v = deps._getConfig?.(key);
  return typeof v === "number" && Number.isFinite(v) ? { [key]: v } : {};
}

/*-
 *  Defaults for the per-position config fallbacks below: the shipped
 *  bot-config-defaults.json, with an operator's copy under
 *  app-config/user-configurable/ on top, which is also what Bot
 *  Settings shows for a setting the position has not saved.  Per
 *  feedback_one_literal_per_shipped_default, the literals live only in
 *  the JSON.
 */
const _DEFAULTS = readBotConfigDefaults();

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
  /*- The Bot Settings → Range section's "No Override" toggle gates all
   *  three Range settings at once.  Resolved through the shared helper
   *  so the bot and `GET /api/status` can never disagree about which
   *  mode a position is in. */
  const rangeCfg = {
    rangeOverrideEnabled: deps._getConfig?.("rangeOverrideEnabled"),
    rebalanceRangeWidthPct: deps._getConfig?.("rebalanceRangeWidthPct"),
    fullRangeRebalanceEnabled: deps._getConfig?.("fullRangeRebalanceEnabled"),
    offsetToken0Pct: deps._getConfig?.("offsetToken0Pct"),
  };
  const rangeOverrideEnabled = resolveRangeOverrideEnabled(rangeCfg);
  /*- Persistent per-position override; empty ⇒ rebalancer falls back to
   *  `rangeMath.preserveRange()` (its existing default).  Truthy check
   *  correctly omits the key for `undefined`, `null`, or `0` — all of
   *  which mean "no override". */
  const crw = rangeOverrideEnabled
    ? rangeCfg.rebalanceRangeWidthPct
    : undefined;
  // Saved, or else the install's default.
  const fullRangeRebalanceEnabled =
    rangeOverrideEnabled && fullRangeSetting(rangeCfg) === true;
  /*-
   *  With the toggle ON the offset is pinned to centred, so
   *  `rangeMath.preserveRange()` re-centres the existing spread on the
   *  current tick.  Neither a saved offset nor a default one may apply
   *  there: either would shift a range the user asked us to re-use. The
   *  rule is shared with `GET /api/status`, which publishes its answer
   *  for the Rebalance Now preview.
   */
  const offsetToken0Pct = resolveRebalanceOffsetPct(rangeCfg);
  return {
    position,
    factoryAddress: config.FACTORY,
    positionManagerAddress: config.POSITION_MANAGER,
    swapRouterAddress: config.SWAP_ROUTER,
    /*-
     *  Slippage is two settings, one per token, and nothing else.
     *  Passed through only when actually set; `resolveSlippagePct`
     *  picks the destination token's and falls back to the default
     *  `slippagePct` when that one is unset.
     */
    ..._optionalConfig(deps, "slippagePctToken0"),
    ..._optionalConfig(deps, "slippagePctToken1"),
    symbol0: getTokenSymbol(position.token0),
    symbol1: getTokenSymbol(position.token1),
    ...(crw ? { customRangeWidthPct: crw } : {}),
    ...(fullRangeRebalanceEnabled ? { fullRangeRebalanceEnabled: true } : {}),
    offsetToken0Pct,
    approvalMultiple:
      deps._getConfig?.("approvalMultiple") ?? _DEFAULTS.approvalMultiple,
    gasFeePct: deps._getConfig?.("gasFeePct"),
  };
}

module.exports = { buildRebalanceOpts };
