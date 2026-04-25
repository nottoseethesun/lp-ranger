/**
 * @file src/bot-config-defaults.js
 * @module botConfigDefaults
 * @description
 * Reads `app-config/static-tunables/bot-config-defaults.json` and exposes
 * the values to the dashboard via `GET /api/bot-config-defaults`.  These
 * are *defaults* for user-editable Bot Config settings: the UI uses them
 * as the initial input value when the user hasn't saved an override yet,
 * and the server falls back to them when `getConfig` is asked for a key
 * that isn't present in `.bot-config.json`.
 *
 * Keys match the bot-config-v2 POSITION_KEYS / GLOBAL_KEYS naming so the
 * same string flows end-to-end (defaults file → dashboard input → saved
 * config → bot reader).
 *
 * New user-setting defaults should be added here (and wired through the
 * normal config save path) rather than each getting its own dedicated
 * tunable file.  The file is re-read on every request so operators can
 * edit it live without a server restart.  Read or parse failures fall
 * back to the built-in defaults below so the endpoint never 500s.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/** Full path to the on-disk tunable. */
const _FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "bot-config-defaults.json",
);

/** Built-in fallback values.  Must match bot-config-defaults.json shape.
 *  Top-level keys are user-editable (surfaced in the Bot Settings UI);
 *  nested groups (lowGasThresholds, residualCleanup) are server-internal
 *  operator tunables not exposed via the dashboard. */
const _FALLBACK = Object.freeze({
  approvalMultiple: 20,
  rebalanceOutOfRangeThresholdPercent: 5,
  rebalanceTimeoutMin: 180,
  slippagePct: 0.5,
  checkIntervalSec: 60,
  minRebalanceIntervalMin: 10,
  maxRebalancesPerDay: 20,
  offsetToken0Pct: 50,
  lowGasThresholds: Object.freeze({
    worstCaseGasFactor: 91,
    safetyMultiplier: 3,
    standardSendGas: 21000,
  }),
  residualCleanup: Object.freeze({
    delayMs: 600_000,
    thresholdPct: 5,
  }),
});

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
  rebalanceOutOfRangeThresholdPercent: (v) => _clampInt(v, 1, 100),
  rebalanceTimeoutMin: (v) => _clampNonNegInt(v, 1440),
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
    const raw = fs.readFileSync(_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const out = { ..._FALLBACK };
    for (const [key, normalize] of Object.entries(_NORMALIZERS)) {
      const v = normalize(parsed[key]);
      if (v !== null) out[key] = v;
    }
    return out;
  } catch (err) {
    console.warn(
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
