/**
 * @file dust.js
 * @module dust
 * @description Inflation-resistant "is this amount dust?" utility.
 *
 * Any code path that needs to decide "is this USD amount small enough to
 * ignore?" should route through here instead of hardcoding a literal USD
 * threshold.  The threshold is pegged to a fraction of one unit of an
 * inflation-resistant reference asset (currently gold, via PAXG/XAUT in
 * `dust-threshold.json`) so it doesn't slowly creep up as fiat inflates —
 * a USD-pegged guard would eventually trigger dust-loops as crypto/token
 * prices rose with inflation.
 *
 * `DUST_THRESHOLD_UNITS` is exported as a **universal constant** — the
 * single source of truth for "how small is dust" across the whole app.
 * Its value, the absolute USD floor, and the price-source tokens used
 * to derive the live USD/unit price all come from `dust-threshold.json`
 * via the layered defaults+user-override loader (see
 * `src/load-merged-defaults.js`).  Operators override at
 * `app-config/user-configurable/dust-threshold.json` without editing
 * code or touching shipped defaults.  Per
 * feedback_one_literal_per_shipped_default, no default values are
 * duplicated in code — every literal lives in the JSON.
 *
 * USD/unit price is fetched via
 * `src/price-fetcher.js#fetchDustUnitPriceUsd`.  If all sources fail,
 * we fall back to the JSON's `fallbackThresholdUsd` so the guard still
 * fires instead of silently disabling itself.
 */

"use strict";

const { fetchDustUnitPriceUsd } = require("./price-fetcher");
const { loadShippedDefaults } = require("./load-merged-defaults");

const _FILENAME = "dust-threshold.json";

/*- Single-source baseline: read the shipped JSON once at module init.
 *  Throws on missing/malformed file (install error, fail loudly).  All
 *  default values live in the JSON — no literal duplicates in code. */
const _SHIPPED = Object.freeze(loadShippedDefaults(_FILENAME));

/** Universal dust size in units of the reference asset.  Single source
 *  of truth across the app for "how small is too small to act on".
 *  Consumers should read it via this export (or call
 *  `getDustThresholdUsd()` / `isDust()`) rather than re-reading the
 *  JSON or hardcoding a number elsewhere. */
const DUST_THRESHOLD_UNITS = _SHIPPED.thresholdUnits;

/** Absolute USD floor used only when the USD/unit fetch returns 0. */
const _FALLBACK_THRESHOLD_USD = _SHIPPED.fallbackThresholdUsd;

/**
 * Current dust threshold in USD.
 * @returns {Promise<{thresholdUsd: number, usdPerUnit: number, units: number, usedFallback: boolean}>}
 */
async function getDustThresholdUsd() {
  const units = DUST_THRESHOLD_UNITS;
  const usdPerUnit = await fetchDustUnitPriceUsd();
  const usedFallback = !(usdPerUnit > 0);
  const thresholdUsd = usedFallback
    ? _FALLBACK_THRESHOLD_USD
    : usdPerUnit * units;
  return { thresholdUsd, usdPerUnit, units, usedFallback };
}

/**
 * Classify a USD amount as dust (below threshold) or not.
 *
 * Sign is ignored — `isDust(-0.5)` and `isDust(0.5)` return the same thing.
 * Non-finite inputs are treated as dust so callers don't need to guard NaN.
 *
 * @param {number} usdAmount
 * @returns {Promise<boolean>} true iff `|usdAmount|` is strictly below threshold.
 */
async function isDust(usdAmount) {
  if (!Number.isFinite(usdAmount)) return true;
  const { thresholdUsd } = await getDustThresholdUsd();
  return Math.abs(usdAmount) < thresholdUsd;
}

module.exports = {
  DUST_THRESHOLD_UNITS,
  isDust,
  getDustThresholdUsd,
  _FALLBACK_THRESHOLD_USD,
};
