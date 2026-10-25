/**
 * @file dashboard-ui-settings.js
 * @description The dashboard settings the server sends, and the one place
 *   the page reads them.
 *
 *   They are `ui-defaults_non-layout_for-server-up-scenario.json`, with an
 *   operator's override applied and each value held to its rule by the
 *   server (`src/lib/ui-defaults.js`), which serves them at
 *   `GET /api/ui-defaults`. `loadUiSettings` asks at startup, right after
 *   the blockchain and before anything polls, asking again until the
 *   server answers (`dashboard-ask-server.js`, as the chain is asked for),
 *   and keeps the answer.
 *
 *   `uiSetting(key)` returns one setting. Startup asks before it starts
 *   anything that reads them, so a read before the answer is a mistake in
 *   the page's own order, and it throws naming the setting rather than
 *   handing back a value nobody chose. Code that can run before the
 *   answer by design, such as a first visit's privacy and sound defaults
 *   or a copy icon clicked in the first moment, waits on
 *   `uiSettingsReady`, or asks `uiSettingsLoaded` first.
 *
 *   The page's two other settings files are not here.
 *   `ui-defaults_layout.json` is built into its CSS. And
 *   `ui-defaults_non-layout_for-server-down-scenario.json` is built into
 *   the page, which needs it while it cannot reach the server; this
 *   module's own question takes its time limit from there.
 */

import { log } from "./dashboard-log.js";
import { askUntilAnswered } from "./dashboard-ask-server.js";
import SERVER_DOWN from "../../../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json" with { type: "json" };

// The server's answer; null until it lands.
let _settings = null;

let _resolveReady;

/**
 * Settles with the settings once the server's answer has landed. Never
 * rejects: startup asks until the server answers.
 * @type {Promise<Readonly<object>>}
 */
export const uiSettingsReady = new Promise((resolve) => {
  _resolveReady = resolve;
});

/**
 * Whether the server's answer has landed.
 * @returns {boolean}
 */
export function uiSettingsLoaded() {
  return _settings !== null;
}

/**
 * Run `fn` with the settings: at once when they have landed, otherwise
 * as soon as they do. For code that can run before the answer by design,
 * such as a copy icon clicked in the first moment, and that should not
 * wait a turn when the answer is already in.
 *
 * @param {(settings: Readonly<object>) => void} fn
 * @returns {void}
 */
export function withUiSettings(fn) {
  if (_settings !== null) fn(_settings);
  else uiSettingsReady.then(fn);
}

/**
 * One of the settings the server sent.
 *
 * @param {string} key  The setting, as named in the settings file.
 * @returns {*} Its value in force.
 * @throws {Error} When read before the answer has landed, or for a
 *   setting the server does not send.
 */
export function uiSetting(key) {
  if (_settings === null)
    throw new Error(
      `dashboard setting ${key} was read before the server sent the settings`,
    );
  if (!Object.hasOwn(_settings, key))
    throw new Error(`${key} is not a setting the server sends`);
  return _settings[key];
}

// Why an answer to `GET /api/ui-defaults` is not one, or null when it is.
function _holdsNoSettings(body) {
  return body !== null &&
    typeof body === "object" &&
    typeof body.dashboardPollIntervalMs === "number"
    ? null
    : "its answer held no dashboard settings";
}

/**
 * Learn the dashboard's settings from the server, asking until it
 * answers. Startup waits for this before it starts anything that reads
 * them.
 *
 * @param {object} opts
 * @param {Function} opts.onUnanswered  Called once for each request that
 *   ends without the settings; startup hands in the status poll's own
 *   counter, as it does for the chain, so a server that never answers
 *   turns the pill to HALTED.
 * @param {Function} opts.onAnswered    Called once, when one brings them.
 * @param {Function} [opts.fetchFn]   The fetch to ask with; the
 *   browser's own unless a test passes a scripted one.
 * @param {number} [opts.askEveryMs]  How long each request has to
 *   answer, and the least time between two.
 * @param {Function} [opts.warnFn]    Where an unanswered request is
 *   logged; the browser console unless a test passes its own.
 * @returns {Promise<Readonly<object>>} The settings.
 */
export async function loadUiSettings({
  onUnanswered,
  onAnswered,
  fetchFn = fetch,
  askEveryMs = SERVER_DOWN.chainQueryTimeoutMs,
  warnFn = log.warn,
}) {
  const body = await askUntilAnswered({
    url: "/api/ui-defaults",
    refusal: _holdsNoSettings,
    logTag: "[ui-settings]",
    asked: "asked the server for the dashboard's settings",
    onUnanswered,
    onAnswered,
    fetchFn,
    askEveryMs,
    warnFn,
  });
  _settings = Object.freeze({ ...body });
  log.info("[ui-settings] dashboard settings received");
  _resolveReady(_settings);
  return _settings;
}
