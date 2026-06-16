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

const { log } = require("./log");
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
  privacyModeEnabled: false,
  privacyBlurWalletAddresses: true,
  privacyBlurUsdAmounts: true,
  privacyUsdAmountThreshold: 99,
});

/*-
 * Clamp the USD-threshold tunable to the 5-digit numeric input range
 * (0..99999). Any non-finite, negative, or out-of-range value falls
 * back to the built-in default so the dashboard never renders "NaN"
 * or a value the input can't accept.
 */
function _normalizeUsdThreshold(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 0 || n > 99999) return null;
  return n;
}

/**
 * Read and parse the UI defaults JSON, stripping the `_comment` key.
 * On any error (missing file, bad JSON, etc.) returns the built-in
 * fallback so callers can treat the result as always-valid.
 * @returns {{ soundsEnabled: boolean, privacyModeEnabled: boolean, privacyBlurWalletAddresses: boolean, privacyBlurUsdAmounts: boolean, privacyUsdAmountThreshold: number }}
 */
function readUiDefaults() {
  try {
    const raw = fs.readFileSync(_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const out = { ..._FALLBACK };
    if (typeof parsed.soundsEnabled === "boolean")
      out.soundsEnabled = parsed.soundsEnabled;
    if (typeof parsed.privacyModeEnabled === "boolean")
      out.privacyModeEnabled = parsed.privacyModeEnabled;
    if (typeof parsed.privacyBlurWalletAddresses === "boolean")
      out.privacyBlurWalletAddresses = parsed.privacyBlurWalletAddresses;
    if (typeof parsed.privacyBlurUsdAmounts === "boolean")
      out.privacyBlurUsdAmounts = parsed.privacyBlurUsdAmounts;
    const t = _normalizeUsdThreshold(parsed.privacyUsdAmountThreshold);
    if (t !== null) out.privacyUsdAmountThreshold = t;
    return out;
  } catch (err) {
    log.warn(
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
