/**
 * @file src/ui-defaults.js
 * @module uiDefaults
 * @description
 * The dashboard settings the server sends:
 * `ui-defaults_non-layout_for-server-up-scenario.json`, with an operator's
 * copy under `app-config/user-configurable/` on top (the layered loader,
 * `src/load-merged-defaults.js`), each value held to its rule.
 * `GET /api/ui-defaults` returns them, and the dashboard asks for them at
 * startup, before it polls (`public/dashboard-ui-settings.js`). The server
 * reads the same values for what depends on them, its copy of the poll
 * interval (`src/config.js`) and the figures the help quotes
 * (`src/resolved-settings.js`), so the server, the page and the help agree.
 *
 * Each setting has one of three rules. An on/off setting must be true or
 * false. A timer setting, one the page turns into a `setTimeout` or
 * `setInterval` delay, must meet the timer rule (`src/timer-bounds.js`).
 * Every other setting must fall in its range in setting-bounds.json, at its
 * own name.
 *
 * The page's two other settings files are not read here:
 * `ui-defaults_layout.json` is built into its CSS, and
 * `ui-defaults_non-layout_for-server-down-scenario.json` into the page,
 * which needs it while it cannot reach the server.
 *
 * **Read once, at startup.** `src/config.js` calls the strict reader as it
 * loads, so a value an operator wrote outside its rule stops the app with
 * one message naming each such setting. That answer is kept, and every
 * later read returns it, so an edit takes effect on restart. Read once,
 * the server's copy of the poll interval cannot drift from the one it
 * sends the page. A file that cannot be read or parsed leaves the shipped
 * values standing, with a warning, so the route never fails.
 */

"use strict";

const { log } = require("./log");
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");
const { assertTimerSec } = require("./timer-bounds");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");

const _FILENAME = "ui-defaults_non-layout_for-server-up-scenario.json";

/*-
 *  The shipped values, read once at module init. A missing or malformed
 *  shipped file throws, since that is an install error. They stand for
 *  any setting the operator did not write, or wrote outside its rule.
 */
const _SHIPPED = Object.freeze(loadShippedDefaults(_FILENAME));

/**
 * Every setting `GET /api/ui-defaults` sends, by name: the shipped file's
 * keys. The API doc's sync check holds docs/openapi.json to this list.
 */
const UI_SETTING_KEYS = Object.freeze(Object.keys(_SHIPPED));

// The on/off settings, which have no range.
const _SWITCHES = Object.freeze([
  "soundsEnabled",
  "privacyModeEnabled",
  "privacyBlurWalletAddresses",
  "privacyBlurUsdAmounts",
]);

// The settings the page turns into a timer delay.
const _TIMERS = Object.freeze([
  "copyFeedbackMs",
  "heapLogIntervalMs",
  "dashboardPollIntervalMs",
]);

/**
 * Why a written value breaks its setting's rule, or null when it keeps it.
 *
 * @param {string} key  The setting.
 * @param {*} v         The value as written.
 * @returns {string|null} The refusal, worded for the startup message.
 */
function _whyRefused(key, v) {
  if (_SWITCHES.includes(key)) {
    return typeof v === "boolean"
      ? null
      : `${key} must be true or false; it is ${JSON.stringify(v)}.`;
  }
  if (_TIMERS.includes(key)) {
    try {
      assertTimerSec({ sec: v, key, defaultSec: _SHIPPED[key] });
      return null;
    } catch (err) {
      return err.message;
    }
  }
  const bound = SETTING_BOUNDS[key];
  return withinBound(v, bound)
    ? null
    : `${key} must be ${boundText(bound)}; it is ${JSON.stringify(v)}.`;
}

/**
 * Read the settings: the shipped value for each, replaced by the
 * operator's where it keeps its rule.
 *
 * @param {{strict: boolean}} opts  Whether a broken rule stops the read.
 * @returns {object} Every setting the shipped file holds.
 * @throws {Error} Tagged `badSettingValue`, strict only, naming each
 *   setting written outside its rule.
 */
function _read({ strict }) {
  let written;
  try {
    written = loadMergedDefaults(_FILENAME);
  } catch (err) {
    log.warn(
      "[ui-defaults] %s could not be read (%s) — using the shipped values",
      _FILENAME,
      err.message,
    );
    return { ..._SHIPPED };
  }
  const out = { ..._SHIPPED };
  const refused = [];
  for (const key of Object.keys(_SHIPPED)) {
    const v = written[key];
    if (v === undefined || v === null) continue;
    const why = _whyRefused(key, v);
    if (why === null) out[key] = v;
    else refused.push(why);
  }
  if (strict && refused.length > 0) {
    const err = new Error(
      `[config] In app-config/user-configurable/${_FILENAME}, ` +
        refused.join(" ") +
        " Correct each there, or remove it to use the shipped default," +
        " and restart.",
    );
    err.badSettingValue = true;
    throw err;
  }
  return out;
}

// The one read, kept for the life of the process.
let _memo = null;

/**
 * The dashboard settings in force. Returns the answer read at startup;
 * read before startup has, it reads the file itself, keeping the shipped
 * value for any setting written outside its rule.
 *
 * @returns {Readonly<object>} Every setting the shipped file holds.
 */
function readUiDefaults() {
  if (_memo === null) _memo = Object.freeze(_read({ strict: false }));
  return _memo;
}

/**
 * The same settings, refusing any written outside its rule. **Call once,
 * at startup, and nowhere else:** `src/config.js` does, so the app does
 * not come up on a value nobody chose. Its answer becomes the one every
 * later read returns.
 *
 * @returns {Readonly<object>} Same as `readUiDefaults`.
 * @throws {Error} Tagged `badSettingValue`, naming each refused setting.
 */
function readUiDefaultsStrict() {
  _memo = Object.freeze(_read({ strict: true }));
  return _memo;
}

/** Forget the kept answer, so the next read goes to the file (tests only). */
function _resetMemoForTests() {
  _memo = null;
}

/**
 * Route handler for `GET /api/ui-defaults`: the dashboard settings in
 * force. Always 200.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleUiDefaults(_req, res, jsonResponse) {
  jsonResponse(res, 200, readUiDefaults());
}

module.exports = {
  UI_SETTING_KEYS,
  readUiDefaults,
  readUiDefaultsStrict,
  handleUiDefaults,
  _resetMemoForTests,
};
