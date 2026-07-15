/**
 * @file src/setting-labels.js
 * @module settingLabels
 * @description
 * Reads `setting-labels.json` (via the layered defaults+user-override
 * loader — see `src/load-merged-defaults.js`) and exposes the internal
 * config-key → { label, unit } mapping to the dashboard via
 * `GET /api/setting-labels`.  Used by the Activity Log formatter to
 * turn a raw "rebalanceRangeWidthPct = 8" saved-setting line into
 * "Range Width for Rebalancing is now 8%".  Keyed directly to the
 * internal key (never by position) so a new setting only needs a
 * one-line addition here to get a friendly log line.
 *
 * The file is re-read on every request so operators can edit
 * `app-config/user-configurable/setting-labels.json` live without a
 * server restart.  Read or parse failures fall back to an empty map
 * so the endpoint never 500s (missing entries fall back to the raw
 * `<key> = <value>` form on the client side).
 */

"use strict";

const { log } = require("./log");
const { loadMergedDefaults } = require("./load-merged-defaults");

const _FILENAME = "setting-labels.json";

/**
 * Read and parse the setting-labels JSON, stripping the `_comment`
 * key and any non-object entries so callers get a clean map keyed
 * only on real config keys with `{ label, unit }` shape.  On any
 * error returns an empty object so callers can treat the result as
 * always-valid.
 * @returns {Record<string, { label: string, unit: string }>}
 */
function readSettingLabels() {
  try {
    const parsed = loadMergedDefaults(_FILENAME);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const label = typeof v.label === "string" ? v.label.trim() : "";
      if (!label) continue;
      const unit = typeof v.unit === "string" ? v.unit : "";
      out[k] = { label, unit };
    }
    return out;
  } catch (err) {
    log.warn("[setting-labels] Falling back to empty map: %s", err.message);
    return {};
  }
}

/**
 * Route handler for `GET /api/setting-labels`.  Always returns 200
 * with a well-formed map (possibly empty); parse failures surface
 * via the empty-map path inside `readSettingLabels()`.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleSettingLabels(_req, res, jsonResponse) {
  jsonResponse(res, 200, readSettingLabels());
}

module.exports = { readSettingLabels, handleSettingLabels };
