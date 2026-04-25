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

/** Built-in fallback values.  Must match bot-config-defaults.json shape. */
const _FALLBACK = Object.freeze({
  approvalMultiple: 20,
});

/*- Clamp `approvalMultiple` to a sensible integer.  Too small loses the
 *  speedup; too large wastes nothing but looks alarming in explorers. */
function _normalizeApprovalMultiple(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 1 || n > 1_000_000) return null;
  return n;
}

/**
 * Read and parse the Bot Config defaults JSON, stripping `_comment`.
 * On any error returns the built-in fallback.
 * @returns {{ approvalMultiple: number }}
 */
function readBotConfigDefaults() {
  try {
    const raw = fs.readFileSync(_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const out = { ..._FALLBACK };
    const am = _normalizeApprovalMultiple(parsed.approvalMultiple);
    if (am !== null) out.approvalMultiple = am;
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
