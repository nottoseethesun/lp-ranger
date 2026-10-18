/**
 * @file src/resolved-settings.js
 * @module resolved-settings
 * @description
 * The settings this install runs on, for everything the dashboard shows
 * about them: the Bot Settings defaults and the figures the help quotes.
 *
 * A setting is resolved in up to three layers: the shipped file under
 * `app-config/app-defaults-for-user-configurable/`, the operator's copy
 * under `app-config/user-configurable/` on top of it, and, for the
 * settings `.env` can set, the environment variable on top of both.
 * `readBotConfigDefaults` gives the first two. `src/config.js` gives all
 * three for the `.env` settings, so they are taken from it rather than
 * read from the environment a second time: what the help states is then
 * the very value the bot acts on.
 *
 * It is a module of its own because it needs both of those, and
 * `src/config.js` reads `src/bot-config-defaults.js` at startup, so
 * neither of them can ask the other.
 *
 * Ranges are not resolved. setting-bounds.json is read from the shipped
 * copy only, since a range an override could widen would bound nothing.
 */

"use strict";

const config = require("./config");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { readUiDefaults } = require("./ui-defaults");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { helpFigures } = require("./help-figures");
const { loadMergedDefaults } = require("./load-merged-defaults");
const { aggregatorNameInUse } = require("./aggregator-in-use");

/*-
 *  The Bot Settings `.env` can set: each key in bot-config-defaults.json,
 *  and the name `src/config.js` gives its resolved value.
 */
const _ENV_SET = Object.freeze({
  rebalanceOutOfRangeThresholdPercent: "REBALANCE_OOR_THRESHOLD_PCT",
  rebalanceTimeoutMin: "REBALANCE_TIMEOUT_MIN",
  impermanentLossGuardPct: "IMPERMANENT_LOSS_GUARD_PCT",
  checkIntervalSec: "CHECK_INTERVAL_SEC",
  minRebalanceIntervalMin: "MIN_REBALANCE_INTERVAL_MIN",
  maxRebalancesPerDay: "MAX_REBALANCES_PER_DAY",
});

/**
 * The Bot Settings defaults in force: what a position with no value of
 * its own runs on.
 * @returns {Readonly<object>} bot-config-defaults.json's keys, resolved.
 */
function resolvedBotDefaults() {
  const out = { ...readBotConfigDefaults() };
  for (const [key, name] of Object.entries(_ENV_SET)) out[key] = config[name];
  return Object.freeze(out);
}

/**
 * Every figure the help quotes, as this install runs.
 * @returns {Readonly<Record<string, string>>} From `helpFigures`.
 */
function resolvedHelpFigures() {
  /*-
   *  The dashboard settings the page is sent, the slippage confirmation
   *  tiers and the NEAR LIMIT threshold among them: the help states what
   *  the page will do.
   */
  const uiDefaults = readUiDefaults();
  /*-
   *  app-runtime.json with the operator's copy on top: `.env` sets none
   *  of the figures taken from it, and startup has held each to its rule.
   */
  const appRuntime = loadMergedDefaults("app-runtime.json");
  return helpFigures({
    botDefaults: resolvedBotDefaults(),
    settingBounds: SETTING_BOUNDS,
    uiDefaults,
    appRuntime,
    txSpeedupSec: config.TX_SPEEDUP_SEC,
    txCancelSec: config.TX_CANCEL_SEC,
    compoundMinFeeUsd: config.COMPOUND_MIN_FEE_USD,
    chainKey: config.CHAIN_NAME,
    chainName: config.CHAIN.displayName,
    // `.env` can name the aggregator url, so the resolved one decides.
    aggregatorName: aggregatorNameInUse(
      config.AGGREGATOR_URL,
      config.AGGREGATOR_NAME,
    ),
  });
}

/**
 * Route handler for `GET /api/bot-config-defaults`: the Bot Settings
 * defaults in force, which Bot Settings shows for a setting the position
 * has not saved and its Default buttons put back. Always 200.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleBotConfigDefaults(_req, res, jsonResponse) {
  jsonResponse(res, 200, resolvedBotDefaults());
}

/**
 * Route handler for `GET /api/help-figures`: the figures the help
 * quotes, and the Bot Settings defaults they were worked out from, for
 * the dashboard's own displays of the same rules. Always 200.
 * @param {import('http').IncomingMessage} _req
 * @param {import('http').ServerResponse} res
 * @param {Function} jsonResponse  `(res, status, body) => void`
 */
function handleHelpFigures(_req, res, jsonResponse) {
  jsonResponse(res, 200, {
    figures: resolvedHelpFigures(),
    botDefaults: resolvedBotDefaults(),
  });
}

module.exports = {
  resolvedBotDefaults,
  resolvedHelpFigures,
  handleBotConfigDefaults,
  handleHelpFigures,
};
