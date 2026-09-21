/**
 * @file dashboard-config-inputs.js
 * @description Populates the Bot Settings form inputs from the
 * `/api/status` payload, and holds the shipped-default cache that the
 * "Default" / "No Offset" buttons inject from.
 *
 * Split out of `dashboard-data.js` when adding the Impermanent Loss
 * Guard's `impermanentLossGuardPct: "inIlGuard"` entry pushed that file
 * one line past the 500-line cap.  This block is the cohesive unit: two
 * key→element maps, the defaults cache fed by the
 * `/api/bot-config-defaults` fetch, and the two functions that write
 * them into the DOM.
 *
 * `_populateConfigInputs` runs once per position (latched by
 * `_configSynced` in dashboard-data.js), `_syncGlobalConfig` once per
 * page load.  Both skip inputs the user is mid-edit on, via the
 * dirty-flag cache.
 */

"use strict";

import { g } from "./dashboard-helpers.js";
import { isInputDirty } from "./dashboard-data-cache.js";
import { applySavedMinInterval } from "./dashboard-throttle.js";
import { rememberGoodInput } from "./dashboard-config-save.js";

/* Map of server config key → form input id. */
const _CONFIG_INPUT_MAP = {
  checkIntervalSec: "inInterval",
  minRebalanceIntervalMin: "inMinInterval",
  maxRebalancesPerDay: "inMaxReb",
  gasStrategy: "inGas",
  rebalanceTimeoutMin: "inOorTimeout",
  impermanentLossGuardPct: "inIlGuard",
  rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
  autoCompoundThresholdUsd: "autoCompoundThreshold",
  offsetToken0Pct: "inOffsetToken0",
  approvalMultiple: "inApprovalMultiple",
};

/* Map of GLOBAL server config key → form input id.  These keys live in
 * `_diskConfig.global` (spread into `/api/status` response), so they
 * sync regardless of which position is active.  Synced exactly once
 * per page load (`_globalSynced`) — subsequent in-page edits are
 * preserved by the dirty-input gate. */
const _GLOBAL_CONFIG_INPUT_MAP = {
  gasFeePct: "inGasFeePct",
};

/* Per-position defaults applied when the key is missing from server
 * data, so the input resets on switch instead of bleeding through the
 * prior position's value.  Starts empty — populated at init by
 * `setConfigInputDefault()` once the `/api/bot-config-defaults` fetch
 * resolves (the server reads the shipped JSON merged with any
 * operator override).  No literal defaults live here: per
 * feedback_one_literal_per_shipped_default, every shipped default
 * value lives in
 * `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`
 * and nowhere else in code.  Until the AJAX call resolves, missing
 * keys leave their input untouched (existing behaviour: inputs that
 * have neither a per-position value nor a default skip rendering). */
const _CONFIG_INPUT_DEFAULTS = {};

/** Read the whole defaults cache (used by `_syncOorThreshold`). */
export function configInputDefaults() {
  return _CONFIG_INPUT_DEFAULTS;
}

/** Update a default value for a config input (called from init once the
 *  server tunables have been fetched). */
export function setConfigInputDefault(key, val) {
  if (val !== undefined && val !== null) _CONFIG_INPUT_DEFAULTS[key] = val;
}

/** Read a single Bot-Setting default sourced from the shipped JSON
 *  via `/api/bot-config-defaults` (populated by `setConfigInputDefault`).
 *  Returns `undefined` if the AJAX fetch hasn't resolved yet OR the
 *  key isn't a known default.  Consumers MUST handle the undefined
 *  case — no literal fallback is allowed per
 *  feedback_one_literal_per_shipped_default. */
export function getInputDefault(key) {
  return _CONFIG_INPUT_DEFAULTS[key];
}

/** Populate config form inputs from a position's server data. */
export function populateConfigInputs(d) {
  for (const [key, elId] of Object.entries(_CONFIG_INPUT_MAP)) {
    const val = d[key] ?? _CONFIG_INPUT_DEFAULTS[key];
    if (val !== undefined && val !== null && !isInputDirty(elId)) {
      const el = g(elId);
      if (el) el.value = val;
      /*- This came from the server, so it is a value the server takes.
       *  A save the server later refuses puts the field back to it. */
      rememberGoodInput(elId, val);
    }
  }
  /*- Seed the client throttle from the SAVED per-position value so the
   *  Doubling Trigger Window label is correct even when no bot loop is
   *  running (dashboard-only mode → no throttleState in the payload at
   *  all) and during the window before a freshly-started bot's first
   *  poll emits a snapshot.  Runs once per position via the
   *  `_configSynced` latch in _syncConfigFromServer; a running bot's
   *  per-poll throttleState sync carries the same saved value, so the
   *  two writers agree. */
  applySavedMinInterval(
    d.minRebalanceIntervalMin ?? _CONFIG_INPUT_DEFAULTS.minRebalanceIntervalMin,
  );
  /*- Keep the complement offset input in sync.  Skip when the
   *  primary input is empty (pre-AJAX init or after Clear Local
   *  Storage) — no literal fallback per
   *  feedback_one_literal_per_shipped_default; the next poll cycle
   *  re-populates once `_CONFIG_INPUT_DEFAULTS.offsetToken0Pct`
   *  arrives. */
  const offEl0 = g("inOffsetToken0");
  const offEl1 = g("inOffsetToken1");
  if (offEl0 && offEl1) {
    const n = parseInt(offEl0.value, 10);
    if (Number.isFinite(n)) offEl1.value = 100 - n;
  }
}

let _globalSynced = false;

/** Re-arm the once-per-page-load global sync (called on position switch). */
export function resetGlobalSynced() {
  _globalSynced = false;
}

/** Populate global-key inputs (e.g. Settings popover Gas Fee %) from
 *  /api/status global block.  Runs once per page load, only after a
 *  real value lands (skips the initial poll where global may be empty). */
export function syncGlobalConfig(d) {
  if (_globalSynced) return;
  let any = false;
  for (const [key, elId] of Object.entries(_GLOBAL_CONFIG_INPUT_MAP)) {
    const val = d[key];
    if (val === undefined || val === null) continue;
    any = true;
    if (isInputDirty(elId)) continue;
    const el = g(elId);
    if (el) el.value = val;
  }
  if (any) _globalSynced = true;
}
