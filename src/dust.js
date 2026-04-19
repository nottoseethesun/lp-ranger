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
 * Its value, and the price-source tokens used to derive the live USD/unit
 * price, are loaded once at module init from
 * `app-config/static-tunables/dust-threshold.json` so operators can tune
 * both without editing code.  The module falls back to `_DEFAULT_UNITS`
 * (1/4800) if the JSON is missing or malformed, so the guard never
 * silently disables itself.
 *
 * USD/unit price is fetched via
 * `src/price-fetcher.js#fetchDustUnitPriceUsd`.  If all sources fail, we
 * fall back to `_FALLBACK_THRESHOLD_USD` so the guard still fires instead
 * of silently disabling itself.
 */

"use strict";

const path = require("path");
const fs = require("fs");

const { fetchDustUnitPriceUsd } = require("./price-fetcher");

/** Absolute USD floor used only when the USD/unit fetch returns 0. */
const _FALLBACK_THRESHOLD_USD = 1.0;

/** Last-resort units value if the JSON config is missing or malformed. */
const _DEFAULT_UNITS = 1 / 4800;

/** On-disk source of truth for the dust-threshold config. */
const _DUST_JSON_PATH = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "dust-threshold.json",
);

/** Load the threshold units from disk; fall back to the default. */
function _loadThresholdUnits() {
  try {
    const raw = fs.readFileSync(_DUST_JSON_PATH, "utf8");
    const json = JSON.parse(raw);
    const val = Number(json?.thresholdUnits);
    if (Number.isFinite(val) && val > 0) return val;
    console.warn(
      "[dust] %s missing/invalid thresholdUnits — using default %s",
      _DUST_JSON_PATH,
      _DEFAULT_UNITS,
    );
    return _DEFAULT_UNITS;
  } catch (err) {
    console.warn(
      "[dust] Could not load %s: %s — using default %s",
      _DUST_JSON_PATH,
      err.message ?? err,
      _DEFAULT_UNITS,
    );
    return _DEFAULT_UNITS;
  }
}

/**
 * Universal "dust" size, in units of the reference asset.
 *
 * Single source of truth across the app for "how small is too small to
 * act on".  Consumers should read it via this export (or call
 * `getDustThresholdUsd()` / `isDust()` which use it internally) rather
 * than re-reading the JSON or hardcoding a number elsewhere.
 */
const DUST_THRESHOLD_UNITS = _loadThresholdUnits();

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
  _DEFAULT_UNITS,
};
