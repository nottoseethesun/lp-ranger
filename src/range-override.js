/**
 * @file src/range-override.js
 * @module range-override
 * @description
 * Single source of truth for the per-position "No Override" toggle that
 * heads the Bot Settings → Range section.
 *
 * The toggle answers one question: does the next rebalance shape its
 * tick range from the saved Range settings, or does it simply re-use the
 * position's existing on-chain range?
 *
 *   - toggle ON  ("No Override")  → `rangeOverrideEnabled === false`
 *     Badge reads "Re-Use Existing Position Range".  `buildRebalanceOpts`
 *     withholds `rebalanceRangeWidthPct` and `fullRangeRebalanceEnabled`
 *     and pins the offset to centred, so `_computeRange` in
 *     `rebalancer-execute.js` lands on `rangeMath.preserveRange()`
 *     centred on the current tick.
 *   - toggle OFF                  → `rangeOverrideEnabled === true`
 *     Badge reads "Use Settings Below".  The saved Price Range Extension,
 *     Full-Range flag, and Position Offset all apply as before.
 *
 * The toggle is deliberately **non-destructive**: flipping it ON leaves
 * every saved Range value on disk (the dashboard greys the fields out
 * rather than emptying them), so flipping it back OFF restores the
 * user's settings exactly.  That is the whole reason it replaced the old
 * one-way "No Override" button, which cleared the keys outright.
 *
 * `resolveRangeOverrideEnabled` is the ONLY place the unset-slot default
 * is decided.  The server calls it from `bot-cycle-opts.js` (what the
 * bot actually does) and from `build-status-positions.js` (what
 * `GET /api/status` publishes), so the dashboard reads a value that is
 * already resolved and never re-derives the rule client-side.
 */

"use strict";

const { readBotConfigDefaults } = require("./bot-config-defaults");
const { CENTERED_OFFSET_PCT } = require("./centered-offset");

/*-
 *  Default for a position that has never been configured: the shipped
 *  value, or the operator's override of it.  Per
 *  feedback_one_literal_per_shipped_default the literal lives only in
 *  bot-config-defaults.json.
 */
const _DEFAULTS = readBotConfigDefaults();

/**
 * Per-position config keys that constitute a Range override.  A slot
 * carrying any of these was configured before the toggle existed, so an
 * absent `rangeOverrideEnabled` resolves to `true` for it — upgrading
 * must never silently stop applying settings a live position already
 * relies on.
 */
const RANGE_OVERRIDE_KEYS = [
  "rebalanceRangeWidthPct",
  "fullRangeRebalanceEnabled",
  "offsetToken0Pct",
];

/**
 * Whether a saved Range override is in force for a position.
 *
 * Resolution order:
 *   1. An explicit boolean `rangeOverrideEnabled` wins — the user has
 *      touched the toggle, so their choice is authoritative.
 *   2. A slot already carrying a Price Range Extension, a `true`
 *      Full-Range flag, or a Position Offset resolves to `true`.  Those
 *      slots predate the toggle; upgrading must not silently stop
 *      applying settings a live position already relies on.
 *   3. Otherwise the default — as shipped, an empty slot, i.e. every
 *      position the first time it is seen, means "No Override".
 *
 * @param {object|null|undefined} posCfg  A position's config slot (or any
 *   object exposing the same keys, e.g. the bag `bot-cycle-opts.js`
 *   assembles from `deps._getConfig`).
 * @returns {boolean}  `true` → apply the saved Range settings.
 */
function resolveRangeOverrideEnabled(posCfg) {
  if (posCfg === undefined || posCfg === null)
    return _DEFAULTS.rangeOverrideEnabled;
  if (typeof posCfg.rangeOverrideEnabled === "boolean")
    return posCfg.rangeOverrideEnabled;
  /*- `fullRangeRebalanceEnabled` only counts when it is `true`: an
   *  explicitly-saved `false` means the user unchecked the box, which
   *  is the absence of an override, not the presence of one. */
  if (posCfg.fullRangeRebalanceEnabled === true) return true;
  for (const k of RANGE_OVERRIDE_KEYS) {
    if (k === "fullRangeRebalanceEnabled") continue;
    if (posCfg[k] !== undefined && posCfg[k] !== null) return true;
  }
  return _DEFAULTS.rangeOverrideEnabled;
}

/**
 * The Position Offset the next rebalance uses: with the Range settings in
 * force, the position's saved offset, or else the install's default
 * (shipped, with the operator's override); with "No Override", centred,
 * so the existing spread is re-used around the current price. The bot
 * builds its rebalance from this (`buildRebalanceOpts`,
 * src/bot-cycle-opts.js) and `GET /api/status` publishes it
 * (src/build-status-positions.js), so the Rebalance Now preview shows the
 * range the rebalance will mint, not one around a centre it assumed.
 * @param {object|null|undefined} posCfg  As for
 *   `resolveRangeOverrideEnabled`.
 * @param {object} [defaults]  The resolved defaults; the install's own
 *   unless a test passes others.
 * @returns {number}  Percent of the range below the current price.
 */
function resolveRebalanceOffsetPct(posCfg, defaults = _DEFAULTS) {
  if (!resolveRangeOverrideEnabled(posCfg)) return CENTERED_OFFSET_PCT;
  const saved = posCfg?.offsetToken0Pct;
  return saved !== undefined && saved !== null
    ? saved
    : defaults.offsetToken0Pct;
}

/**
 * The Full-Range flag among a position's Range settings: its saved one,
 * or else `true` when the install's default turns Full-Range on (shipped,
 * with the operator's override). With neither there is none, and a
 * rebalance with the Range settings in force keeps the position's own
 * spread, so the dashboard's checkbox shows whether that spread is full
 * range already. The bot applies this flag only while the Range settings
 * are in force (`buildRebalanceOpts`, src/bot-cycle-opts.js), and
 * `GET /api/status` publishes it for the checkbox
 * (src/build-status-positions.js).
 * @param {object|null|undefined} posCfg  As for
 *   `resolveRangeOverrideEnabled`.
 * @param {object} [defaults]  The resolved defaults; the install's own
 *   unless a test passes others.
 * @returns {boolean|undefined}
 */
function fullRangeSetting(posCfg, defaults = _DEFAULTS) {
  const saved = posCfg?.fullRangeRebalanceEnabled;
  if (typeof saved === "boolean") return saved;
  return defaults.fullRangeRebalanceEnabled === true ? true : undefined;
}

module.exports = {
  resolveRangeOverrideEnabled,
  resolveRebalanceOffsetPct,
  fullRangeSetting,
  RANGE_OVERRIDE_KEYS,
};
