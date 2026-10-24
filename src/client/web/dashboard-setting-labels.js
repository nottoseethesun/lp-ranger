/**
 * @file dashboard-setting-labels.js
 * @description Human-readable label lookup for the Activity Log
 * "Setting Saved" formatter.  Fetched once at page init from
 * `GET /api/setting-labels`; the raw internal config key is the
 * dictionary key (never a positional lookup), so a new setting only
 * needs a one-line entry in
 * `app-config/app-defaults-for-user-configurable/setting-labels.json`
 * to get a friendly log line.
 *
 * Missing entries — including a total fetch failure — fall through
 * to the raw `<key> = <value>` form so a missing label never breaks
 * the log line.
 */

"use strict";

import { log } from "./dashboard-log.js";

let _LABELS = {};

/**
 * Fetch the labels map from the server once at page init.  Silent
 * on failure — falls back to the empty map, which surfaces as the
 * `<key> = <value>` fallback shape at each call site.
 * @returns {Promise<void>}
 */
export function loadSettingLabels() {
  return fetch("/api/setting-labels")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && typeof d === "object") _LABELS = d;
    })
    .catch((e) => log.warn("[settingLabels] fetch failed: %s", e?.message));
}

/**
 * Format a "Setting Saved" activity-log detail line for a given
 * (internal key, new value) pair.  Returns the friendly form
 * `<label> is now <value><unit>` when a label entry exists;
 * otherwise falls back to `<key> = <value>`.
 * @param {string} key
 * @param {*} value
 * @returns {string}
 */
export function formatSettingChange(key, value) {
  const entry = _LABELS[key];
  if (!entry || !entry.label) return key + " = " + value;
  return entry.label + " is now " + value + entry.unit;
}

/**
 * Look up the label for a given key without the "is now" prefix —
 * used for messages like `<label> cleared — using default`.  Falls
 * back to the raw key when no label is registered so the message
 * still round-trips information.
 * @param {string} key
 * @returns {string}
 */
export function labelForKey(key) {
  const entry = _LABELS[key];
  return (entry && entry.label) || key;
}
