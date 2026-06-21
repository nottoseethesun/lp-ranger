/**
 * @file src/ui-defaults.js
 * @module uiDefaults
 * @description
 * Reads `ui-defaults.json` (via the layered defaults+user-override
 * loader — see `src/load-merged-defaults.js`) and exposes the values
 * to the dashboard via `GET /api/ui-defaults`. These are *defaults*
 * only — they apply when the corresponding localStorage key is absent
 * in the browser (first visit or after "Clear Local Storage &
 * Cookies"). Toggles in the Settings popover persist locally and
 * always override.
 *
 * The file is re-read on every request so operators can edit
 * `app-config/user-configurable/ui-defaults.json` live without a
 * server restart.  Read or parse failures fall back to the built-in
 * defaults below so the endpoint never 500s.
 */

"use strict";

const { log } = require("./log");
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");

const _FILENAME = "ui-defaults.json";

/*- Single-source baseline: read the shipped JSON once at module init.
 *  Throws on missing/malformed file (install error, fail loudly).
 *  Used as the per-key fallback when an operator's live override fails
 *  validation.  See feedback_one_literal_per_shipped_default — every
 *  default value lives in the JSON, nowhere else in code. */
const _FALLBACK = Object.freeze(loadShippedDefaults(_FILENAME));

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
    const parsed = loadMergedDefaults(_FILENAME);
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
