/**
 * @file src/bot-config-defaults.js
 * @module botConfigDefaults
 * @description
 * Reads `bot-config-defaults.json` (via the layered defaults+user-
 * override loader — see `src/load-merged-defaults.js`) and exposes the
 * values to the dashboard via `GET /api/bot-config-defaults`.  These
 * are *defaults* for user-editable Bot Config settings: the UI uses
 * them as the initial input value when the user hasn't saved an
 * override yet, and the server falls back to them when `getConfig` is
 * asked for a key that isn't present in `bot-config.json`.
 *
 * Keys match the bot-config-v2 POSITION_KEYS / GLOBAL_KEYS naming so
 * the same string flows end-to-end (defaults file → dashboard input →
 * saved config → bot reader).
 *
 * New user-setting defaults should be added here (and wired through
 * the normal config save path) rather than each getting its own
 * dedicated tunable file.  The file is re-read on every request so
 * operators can edit
 * `app-config/user-configurable/bot-config-defaults.json` live without
 * a server restart.  Read or parse failures fall back to the built-in
 * defaults below so the endpoint never 500s.
 */

"use strict";

const { log } = require("./log");
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");

const _FILENAME = "bot-config-defaults.json";

/*- Single-source baseline: read the shipped JSON once at module init.
 *  Throws on missing/malformed file (install error, fail loudly).  Used
 *  as the per-key fallback when an operator's live user-configurable
 *  override contains an out-of-range value (the runtime then falls
 *  back to the last-known-good shipped value rather than propagating
 *  the bad override).  See feedback_one_literal_per_shipped_default —
 *  every default value lives in the JSON, nowhere else in code. */
const _FALLBACK = Object.freeze(loadShippedDefaults(_FILENAME));

/*- Clamp `approvalMultiple` to a sensible integer.  Too small loses the
 *  speedup; too large wastes nothing but looks alarming in explorers. */
function _normalizeApprovalMultiple(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 1 || n > 1_000_000) return null;
  return n;
}

/*- Generic positive-int clamp with min/max bounds.  Returns null when
 *  the value is non-numeric or falls outside the allowed range. */
function _clampInt(v, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < min || n > max) return null;
  return n;
}

/*- Same as `_clampInt` but allows zero (for fields like
 *  `rebalanceTimeoutMin` where 0 = disabled). */
function _clampNonNegInt(v, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 0 || n > max) return null;
  return n;
}

/*- Clamp a positive float to [min, max].  Returns null on failure. */
function _clampFloat(v, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

/*- Per-key fallback merge for the lowGasThresholds nested group.  Any
 *  missing or invalid sub-field falls back to its built-in default so a
 *  partially-edited JSON still produces a fully-populated group. */
function _normalizeLowGasThresholds(v) {
  const fb = _FALLBACK.lowGasThresholds;
  if (!v || typeof v !== "object") return { ...fb };
  const out = { ...fb };
  const wcgf = _clampInt(v.worstCaseGasFactor, 1, 10_000);
  if (wcgf !== null) out.worstCaseGasFactor = wcgf;
  const sm = _clampInt(v.safetyMultiplier, 1, 100);
  if (sm !== null) out.safetyMultiplier = sm;
  const ssg = _clampInt(v.standardSendGas, 21_000, 1_000_000);
  if (ssg !== null) out.standardSendGas = ssg;
  return out;
}

/*- Per-key fallback merge for the residualCleanup nested group.  Same
 *  partial-customisation semantics as _normalizeLowGasThresholds. */
function _normalizeResidualCleanup(v) {
  const fb = _FALLBACK.residualCleanup;
  if (!v || typeof v !== "object") return { ...fb };
  const out = { ...fb };
  const dm = _clampInt(v.delayMs, 1, 24 * 60 * 60_000);
  if (dm !== null) out.delayMs = dm;
  const tp = _clampFloat(v.thresholdPct, 0.01, 100);
  if (tp !== null) out.thresholdPct = tp;
  return out;
}

/** Mapping of JSON key → normalizer producing the cleaned value or null. */
const _NORMALIZERS = {
  approvalMultiple: _normalizeApprovalMultiple,
  /*- gasFeePct bounds come from the shipped JSON itself (gasFeePctMin /
   *  gasFeePctMax) so the literal pair lives in one place per
   *  feedback_one_literal_per_shipped_default.  src/swap-gates.js reads
   *  the same values for its UI clamping. */
  gasFeePct: (v) =>
    _clampFloat(v, _FALLBACK.gasFeePctMin, _FALLBACK.gasFeePctMax),
  /*- Price-source cache TTL: 1 s minimum (no point caching shorter than
   *  the poll cadence); 24 h ceiling (longer would hide real moves). */
  priceCacheTtlMs: (v) => _clampInt(v, 1_000, 24 * 60 * 60_000),
  /*- Dust-unit-price cache multiplier: positive integer >= 1 so the
   *  derived `dust = price * multiplier` stays a clean integer multiple.
   *  Cap at 1000 to keep the dust cache horizon sane (1000 * 24 h max). */
  dustUnitPriceCacheMultiplier: (v) => _clampInt(v, 1, 1000),
  /*- Move-scope cache TTL: at least 1 s (sub-second freshness has no
   *  benefit; a single price fetch already takes ~100-500 ms), capped at
   *  60 s (longer would defeat the "fresh during move" intent). */
  moveCacheTtlMs: (v) => _clampInt(v, 1_000, 60_000),
  /*- Balanced-band notifier multiplier: positive integer >= 1.  Cap at
   *  10000 so an absurd value still produces a finite cadence (10 000 ×
   *  60 s ≈ 7 days between checks). */
  pricePauseExceptionPollWindowMultiple: (v) => _clampInt(v, 1, 10000),
  rebalanceOutOfRangeThresholdPercent: (v) => _clampInt(v, 1, 100),
  rebalanceTimeoutMin: (v) => _clampNonNegInt(v, 1440),
  /*- Range width bounds match the "Range Width" input attrs in
   *  public/index.html (min=0.1 max=200) and dashboard-throttle.js
   *  `saveRangeWidth` rejection guard.  Value is exposed via
   *  /api/bot-config-defaults so the "Default" button in Bot Settings
   *  can inject it into the input; the bot itself does NOT fall back
   *  to this value at rebalance time (undefined config still means
   *  preserveRange()). */
  rebalanceRangeWidthPct: (v) => _clampFloat(v, 0.1, 200),
  slippagePct: (v) => _clampFloat(v, 0.1, 5),
  checkIntervalSec: (v) => _clampInt(v, 10, 3600),
  minRebalanceIntervalMin: (v) => _clampInt(v, 1, 1440),
  maxRebalancesPerDay: (v) => _clampInt(v, 1, 200),
  offsetToken0Pct: (v) => _clampNonNegInt(v, 100),
  lowGasThresholds: _normalizeLowGasThresholds,
  residualCleanup: _normalizeResidualCleanup,
};

/**
 * Read and parse the Bot Config defaults JSON, stripping `_comment` and
 * `_migration`.  Each known key passes through its normalizer; values
 * that fail clamping fall back to the built-in default for that key.
 * @returns {object}  Defaults object with the same keys as `_FALLBACK`.
 */
function readBotConfigDefaults() {
  try {
    const parsed = loadMergedDefaults(_FILENAME);
    const out = { ..._FALLBACK };
    for (const [key, normalize] of Object.entries(_NORMALIZERS)) {
      const v = normalize(parsed[key]);
      if (v !== null) out[key] = v;
    }
    return out;
  } catch (err) {
    log.warn(
      "[bot-config-defaults] Falling back to built-in defaults: %s",
      err.message,
    );
    return { ..._FALLBACK };
  }
}

/**
 * Route handler for `GET /api/bot-config-defaults`.  Always returns 200
 * with a well-formed defaults object.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleBotConfigDefaults(_req, res, jsonResponse) {
  jsonResponse(res, 200, readBotConfigDefaults());
}

module.exports = { readBotConfigDefaults, handleBotConfigDefaults };
