/**
 * @file src/optimizer-applicator.js
 * @module optimizerApplicator
 * @description
 * Applies an {@link OptimizationRecommendation} from the LP Optimization Engine
 * to the Position Manager's live bot parameters.
 *
 * Design principles
 * ─────────────────
 * - **Non-destructive**: every application produces a {@link ApplyResult}
 *   that lists exactly what changed, what was skipped, and why.  The caller
 *   can log or display this audit trail without re-querying the engine.
 *
 * - **Incremental**: only fields that are present in the recommendation AND
 *   differ from their current values are written.  Fields absent from the
 *   recommendation are left completely untouched.
 *
 * - **Reversible**: the full previous parameter state is captured in the
 *   `ApplyResult.previous` snapshot, allowing a one-step undo.
 *
 * - **Decoupled from transport**: this module never calls HTTP.  It operates
 *   purely on plain JavaScript objects and functions, making it trivially
 *   testable without mocks.
 *
 * Parameter surface (all fields of BotParams)
 * ─────────────────────────────────────────────
 * The following bot parameters can be overridden by the optimizer:
 *
 *   rangeWidthPct           – range width ± % for new LP deposit
 *   triggerType             – 'oor' | 'edge' | 'time'
 *   edgePct                 – edge-buffer % (used when triggerType === 'edge')
 *   schedHours              – schedule interval (used when triggerType === 'time')
 *   minRebalanceIntervalMin – min minutes between rebalances
 *   maxRebalancesPerDay     – daily rebalance cap
 *   slippagePct             – max slippage %
 *   checkIntervalSec        – on-chain poll frequency
 *
 * @example
 * const { applyRecommendation } = require('./optimizer-applicator');
 *
 * const current = { rangeWidthPct: 20, triggerType: 'oor', slippagePct: 0.5, … };
 * const rec     = { rangeWidthPct: 15, rationale: 'Low volatility detected.' };
 * const result  = applyRecommendation(current, rec);
 * // result.changes = [{ field: 'rangeWidthPct', from: 20, to: 15 }]
 */

'use strict';

/**
 * @typedef {Object} BotParams
 * All values that the optimizer is allowed to read and write.
 * @property {number}              rangeWidthPct
 * @property {'oor'|'edge'|'time'} triggerType
 * @property {number}              edgePct
 * @property {number}              schedHours
 * @property {number}              minRebalanceIntervalMin
 * @property {number}              maxRebalancesPerDay
 * @property {number}              slippagePct
 * @property {number}              checkIntervalSec
 */

/**
 * @typedef {Object} FieldChange
 * @property {string} field   Parameter name that changed.
 * @property {*}      from    Previous value.
 * @property {*}      to      New value.
 */

/**
 * @typedef {Object} SkippedField
 * @property {string} field   Parameter name that was not applied.
 * @property {string} reason  Human-readable reason (e.g. 'no change', 'not in recommendation').
 */

/**
 * @typedef {Object} ApplyResult
 * @property {boolean}       applied     True if at least one field changed.
 * @property {FieldChange[]} changes     Fields that were updated.
 * @property {SkippedField[]} skipped    Fields in the recommendation that were not updated.
 * @property {BotParams}     previous    Snapshot of params before this application.
 * @property {BotParams}     current     Snapshot of params after this application.
 * @property {string}        [rationale] Optimizer's rationale string, if provided.
 * @property {number}        [confidence] Optimizer's confidence score, if provided.
 * @property {string}        appliedAt   ISO timestamp.
 */

/** Ordered list of all parameter keys the applicator manages. */
const MANAGED_KEYS = [
  'rangeWidthPct',
  'triggerType',
  'edgePct',
  'schedHours',
  'minRebalanceIntervalMin',
  'maxRebalancesPerDay',
  'slippagePct',
  'checkIntervalSec',
];

/**
 * Return true if two values are considered equal for change-detection purposes.
 * Uses strict equality but treats NaN === NaN as equal.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) < 1e-9; // float-safe comparison
  }
  return a === b;
}

/**
 * Apply a validated recommendation to the current bot parameters.
 *
 * This function is **pure with respect to the params object** — it mutates
 * `params` in place AND returns an ApplyResult so callers can observe exactly
 * what happened.  The mutation is intentional: `params` is the live shared
 * state object in both the bot process and the dashboard.
 *
 * @param {BotParams}                params         Mutable current parameters object.
 * @param {import('./optimizer-client').OptimizationRecommendation} rec
 * @returns {ApplyResult}
 */
function applyRecommendation(params, rec) {
  // Capture pre-application snapshot
  const previous = snapshotParams(params);

  /** @type {FieldChange[]} */
  const changes = [];

  /** @type {SkippedField[]} */
  const skipped = [];

  for (const key of MANAGED_KEYS) {
    if (!(key in rec)) {
      // Field absent from recommendation — leave params untouched
      skipped.push({ field: key, reason: 'not in recommendation' });
      continue;
    }

    const newVal = rec[key];
    const oldVal = params[key];

    if (valuesEqual(oldVal, newVal)) {
      skipped.push({ field: key, reason: 'no change' });
      continue;
    }

    params[key] = newVal;
    changes.push({ field: key, from: oldVal, to: newVal });
  }

  const current = snapshotParams(params);

  return {
    applied:    changes.length > 0,
    changes,
    skipped,
    previous,
    current,
    rationale:  rec.rationale  ?? null,
    confidence: rec.confidence ?? null,
    appliedAt:  new Date().toISOString(),
  };
}

/**
 * Create a shallow snapshot of the managed parameters.
 * @param {BotParams} params
 * @returns {BotParams}
 */
function snapshotParams(params) {
  const snap = {};
  for (const key of MANAGED_KEYS) {
    snap[key] = params[key];
  }
  return snap;
}

/**
 * Build a human-readable summary string of an ApplyResult.
 * Suitable for logging and the activity feed.
 * @param {ApplyResult} result
 * @returns {string}
 */
function formatApplyResult(result) {
  if (!result.applied) {
    return 'Optimizer recommendation received — no parameters changed.';
  }
  const lines = result.changes.map(c =>
    `  ${c.field}: ${formatValue(c.from)} → ${formatValue(c.to)}`,
  );
  const conf = result.confidence !== null
    ? ` (confidence: ${(result.confidence * 100).toFixed(0)}%)`
    : '';
  return `Optimizer applied ${result.changes.length} change${result.changes.length !== 1 ? 's' : ''}${conf}:\n${lines.join('\n')}`;
}

/**
 * Format a parameter value for display.
 * @param {*} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

/**
 * Return a fresh BotParams object populated with system defaults.
 * Used as a baseline when no live params object exists yet (e.g. in tests).
 * @returns {BotParams}
 */
function defaultParams() {
  return {
    rangeWidthPct:           20,
    triggerType:             'oor',
    edgePct:                 5,
    schedHours:              24,
    minRebalanceIntervalMin: 10,
    maxRebalancesPerDay:     20,
    slippagePct:             0.5,
    checkIntervalSec:        60,
  };
}

// ── exports ───────────────────────────────────────────────────────────────────
module.exports = {
  applyRecommendation,
  snapshotParams,
  formatApplyResult,
  formatValue,
  defaultParams,
  MANAGED_KEYS,
};
