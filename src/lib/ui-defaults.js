/**
 * @file src/lib/ui-defaults.js
 * @module uiDefaults
 * @description
 * The dashboard settings the server sends:
 * `ui-defaults_non-layout_for-server-up-scenario.json`, with an operator's
 * copy under `app-config/user-configurable/` on top (the layered loader,
 * `src/lib/load-merged-defaults.js`), each value held to its rule.
 * `GET /api/ui-defaults` returns them, and the dashboard asks for them at
 * startup, before it polls (`src/client/web/js/dashboard-ui-settings.js`). The
 * server and the bot read the same values for what depends on them: the
 * poll interval the status answer repeats (`src/server/handle-api-status.js`),
 * the bot's wait for the dashboard to see a change
 * (`src/bot/dashboard-has-polled.js`) and the figures the help quotes
 * (`src/server/resolved-settings.js`), so the bot, the server, the page and
 * the help agree.
 *
 * Each setting has one of three rules. An on/off setting must be true or
 * false. A timer setting, one the page turns into a `setTimeout` or
 * `setInterval` delay, must meet the timer rule (`src/lib/timer-bounds.js`).
 * Every other setting must fall in its range in setting-bounds.json, at its
 * own name.
 *
 * The page's two other settings files are not read here:
 * `ui-defaults_layout.json` is built into its CSS, and
 * `ui-defaults_non-layout_for-server-down-scenario.json` into the page,
 * which needs it while it cannot reach the server.
 *
 * **Read once.** A value an operator wrote outside its rule has stopped the
 * app before it got this far: the startup check
 * (`src/lib/settings-check.js`) names each one. The first read is kept, and
 * every later read returns it, so an edit takes effect on restart and the
 * poll interval the server sends cannot drift from the one the bot waits
 * on. A file that cannot be read or parsed leaves the shipped values
 * standing, with a warning, so the route never fails.
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
  "staleDataCheckIntervalMs",
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
 * The dashboard settings in force: the first read, kept for the life of
 * the process. That read keeps the shipped value for any setting written
 * outside its rule, which the startup check has refused already.
 *
 * @returns {Readonly<object>} Every setting the shipped file holds.
 */
function readUiDefaults() {
  if (_memo === null) _memo = Object.freeze(_read({ strict: false }));
  return _memo;
}

/**
 * The same settings, refusing any written outside its rule, for a caller
 * that must not run on a value nobody chose. The app itself reads only
 * `readUiDefaults`, since the startup check refuses such a value first.
 * Its answer becomes the one every later read returns.
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

module.exports = {
  UI_SETTING_KEYS,
  readUiDefaults,
  readUiDefaultsStrict,
  _resetMemoForTests,
};
