/**
 * @file src/telegram-notifications/telegram-events.js
 * @module telegram-events
 * @description
 * The Telegram alerts LP Ranger can send, and whether each is on until an
 * operator chooses. The operator's choices are kept in bot-config.json as
 * `global.telegramEvents`, keyed by these names.
 *
 * The one list of them. Pure data with no dependencies, so the sender
 * (telegram.js), the dashboard's Telegram dialog and the settings check
 * (src/settings-check.js) all read it, the last two without loading the
 * sender, which reads the app's config. The rule for an operator's
 * choices lives beside the list (`alertChoicesProblem`), so the route
 * that saves them and the settings check that reads them back at
 * startup judge them alike.
 */

"use strict";

/** Event types and their default enabled state. */
const EVENT_DEFAULTS = Object.freeze({
  oorTimeout: true,
  rebalanceSuccess: false,
  rebalanceFail: true,
  compoundSuccess: false,
  compoundFail: true,
  otherError: true,
  lowGasBalance: true,
  veryLowGas: true,
  shutdown: true,
  positionRetired: true,
  positionDataInvalid: true,
  /*-
   *  Impermanent Loss Guard rejection.  Default ON: the bot has
   *  declined to act on a position that is out of range and earning
   *  nothing, and the block clears only when the price recovers or the
   *  operator raises the Guard, so the operator needs to know it is
   *  happening.
   */
  ilGuardRejected: true,
  /*-
   *  Balanced-band notifier
   *  (src/telegram-notifications/balanced-notifier.js). Default OFF:
   *  enabling it bypasses the idle-driven price-lookup pause for these
   *  positions, so price-source quota is consumed even when the
   *  dashboard is closed.
   */
  positionBalanced: false,
});

/*-
 *  The title each alert is sent under, which the dashboard's Telegram
 *  dialog also labels its checkbox with. Position Balanced quotes its
 *  band, so its title is made by `eventTitle`.
 */
const _TITLES = Object.freeze({
  oorTimeout: "OOR Timeout Triggered",
  rebalanceSuccess: "Rebalance Succeeded",
  rebalanceFail: "Rebalance Failed",
  compoundSuccess: "Compound Succeeded",
  compoundFail: "Compound Failed",
  otherError: "Other Error",
  lowGasBalance: "Low Gas Balance",
  veryLowGas: "Very Low Gas",
  shutdown: "Server and Bot Shutdown/Exit",
  positionRetired: "Drained Position Auto-Retired",
  positionDataInvalid: "Position Auto-Stopped: Invalid Token Data",
  ilGuardRejected: "Rebalance Rejected Due to Excessive Impermanent Loss",
});

/**
 * The title an alert is sent under, and its checkbox's label.
 *
 * Position Balanced quotes the band from `positionBalancedBandPct`, the
 * setting the notifier tests against, so the title names the band the
 * alert used.
 *
 * @param {string} id  An alert's name, a key of `EVENT_DEFAULTS`.
 * @param {number|string} bandPct  `positionBalancedBandPct`, for Position
 *   Balanced's title; a dash where it is not known yet.
 * @returns {string}
 */
function eventTitle(id, bandPct) {
  if (id === "positionBalanced")
    return `Position Balanced (±${bandPct}% of 50/50)`;
  return _TITLES[id];
}

/**
 * What is wrong with a set of alert choices, or null when nothing is.
 *
 * The choices are an object naming alerts from `EVENT_DEFAULTS`, each
 * true or false; an alert left out keeps its default. The Telegram
 * settings route holds a save to this rule before it writes anything,
 * and the settings check holds the saved set to it at startup.
 *
 * @param {*} value  The choices, as saved or as a request carries them.
 * @returns {string|null}
 */
function alertChoicesProblem(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "must be the alerts chosen, each true or false";
  for (const [id, on] of Object.entries(value)) {
    if (!Object.hasOwn(EVENT_DEFAULTS, id))
      return `names ${JSON.stringify(id)}, which is not an alert LP Ranger sends`;
    if (typeof on !== "boolean")
      return `${id} must be true or false; it is ${JSON.stringify(on)}`;
  }
  return null;
}

module.exports = { EVENT_DEFAULTS, eventTitle, alertChoicesProblem };
