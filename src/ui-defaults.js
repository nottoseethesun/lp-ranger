/**
 * @file src/ui-defaults.js
 * @module uiDefaults
 * @description
 * Reads `app-config/static-tunables/ui-defaults.json` and exposes the values
 * to the dashboard via `GET /api/ui-defaults`. These are *defaults* only —
 * they apply when the corresponding localStorage key is absent in the
 * browser (first visit or after "Clear Local Storage & Cookies"). Toggles
 * in the Settings popover persist locally and always override.
 *
 * The file is re-read on every request so operators can edit it live
 * without a server restart. Read or parse failures fall back to the
 * built-in defaults below so the endpoint never 500s.
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
  "ui-defaults.json",
);

/** Built-in fallback values. Must match ui-defaults.json shape. */
const _FALLBACK = Object.freeze({
  soundsEnabled: true,
});

/**
 * Read and parse the UI defaults JSON, stripping the `_comment` key.
 * On any error (missing file, bad JSON, etc.) returns the built-in
 * fallback so callers can treat the result as always-valid.
 * @returns {{ soundsEnabled: boolean }}
 */
function readUiDefaults() {
  try {
    const raw = fs.readFileSync(_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const out = { ..._FALLBACK };
    if (typeof parsed.soundsEnabled === "boolean")
      out.soundsEnabled = parsed.soundsEnabled;
    return out;
  } catch (err) {
    console.warn(
      "[ui-defaults] Falling back to built-in defaults: %s",
      err.message,
    );
    return { ..._FALLBACK };
  }
}

/**
 * Route handler for `GET /api/ui-defaults`. Always returns 200 with a
 * well-formed defaults object; parse failures surface via the `_FALLBACK`
 * path inside `readUiDefaults()`.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleUiDefaults(_req, res, jsonResponse) {
  jsonResponse(res, 200, readUiDefaults());
}

module.exports = { readUiDefaults, handleUiDefaults };
