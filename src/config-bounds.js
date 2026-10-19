/**
 * @file src/config-bounds.js
 * @module configBounds
 * @description
 * The one place that decides whether a value an operator typed into the
 * dashboard may be saved, and with it any value `POST /api/config` is
 * sent: the route accepts the bot's own records as well, and those are
 * held to the shapes the bot writes (`src/config-record-checks.js`).
 *
 * **Why the server.** The dashboard used to decide this, and each
 * control decided it differently: four settings quietly rewrote what
 * was typed to the nearest allowed figure and saved that, three
 * refused with no message at all, and the rest each raised a modal of
 * their own wording. None of it bound a request that did not come from
 * the form. The rule an operator's value must satisfy is now here, on
 * the one path every save takes, and the browser sends what was typed
 * without an opinion.
 *
 * **Why it refuses rather than corrects.** A value silently replaced is
 * a setting nobody chose, and the setting is then the last thing anyone
 * would think to check. `POST /api/config` answers 400 naming the
 * setting in `invalidValueForKey`, and the dashboard puts the field
 * back to the value the server last accepted and says why.
 *
 * **Where the numbers come from.** Every range is read from
 * `setting-bounds.json` through `src/setting-bounds.js`, which also
 * gives `src/bot-config-defaults.js` the same figures for the shipped
 * file's own values: one declaration, two policies. No setting that
 * becomes a `setTimeout` delay is saved from the dashboard; where one is
 * read, `src/timer-bounds.js` is the single authority on it.
 */

"use strict";

const validator = require("validator");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");
const { readSettingLabels } = require("./setting-labels");
const { RECORD_CHECKS } = require("./config-record-checks");

/*- An RPC endpoint must carry its scheme, because that is what the
 *  provider dials. `require_tld` is off so a node on the operator's own
 *  machine (`http://127.0.0.1:8545`, `https://localhost:8545`) is
 *  accepted; the protocol list is what keeps `javascript:` and the
 *  like out. */
const _URL_OPTS = Object.freeze({
  protocols: ["http", "https"],
  require_protocol: true,
  require_tld: false,
});

/**
 * Ranges for the settings whose acceptable values are a plain numeric
 * interval, each taken from `setting-bounds.json`. The two decimals
 * overrides share the range every ERC-20 decimals is held to, whether
 * read from the chain or typed. The price-cache settings have no field
 * on the dashboard, but `POST /api/config` saves them all the same, and
 * the price code reads what was saved at its next start.
 */
const BOUNDS = Object.freeze({
  priceCacheTtlMs: SETTING_BOUNDS.priceCacheTtlMs,
  dustUnitPriceCacheMultiplier: SETTING_BOUNDS.dustUnitPriceCacheMultiplier,
  moveCacheTtlMs: SETTING_BOUNDS.moveCacheTtlMs,
  pricePauseExceptionPollWindowMultiple:
    SETTING_BOUNDS.pricePauseExceptionPollWindowMultiple,
  rebalanceTimeoutMin: SETTING_BOUNDS.rebalanceTimeoutMin,
  minRebalanceIntervalMin: SETTING_BOUNDS.minRebalanceIntervalMin,
  maxRebalancesPerDay: SETTING_BOUNDS.maxRebalancesPerDay,
  impermanentLossGuardPct: SETTING_BOUNDS.impermanentLossGuardPct,
  rebalanceOutOfRangeThresholdPercent:
    SETTING_BOUNDS.rebalanceOutOfRangeThresholdPercent,
  rebalanceRangeWidthPct: SETTING_BOUNDS.rebalanceRangeWidthPct,
  offsetToken0Pct: SETTING_BOUNDS.offsetToken0Pct,
  slippagePctToken0: SETTING_BOUNDS.slippagePctToken0,
  slippagePctToken1: SETTING_BOUNDS.slippagePctToken1,
  approvalMultiple: SETTING_BOUNDS.approvalMultiple,
  gasFeePct: SETTING_BOUNDS.gasFeePct,
  initialDepositUsd: SETTING_BOUNDS.initialDepositUsd,
  decimalsOverride0: SETTING_BOUNDS.tokenDecimals,
  decimalsOverride1: SETTING_BOUNDS.tokenDecimals,
});

/*- Settings whose value is a yes or a no. */
const _BOOLEAN_KEYS = Object.freeze([
  "moralisEnabled",
  "rangeOverrideEnabled",
  "fullRangeRebalanceEnabled",
  "priceOverrideForce",
  "decimalsOverrideForce0",
  "decimalsOverrideForce1",
  "autoCompoundEnabled",
]);

/**
 * Name a setting the way the dashboard names it, so the message the
 * operator reads says the same thing as the field they typed into.
 * Falls back to the key when the labels file has no entry.
 *
 * @param {string} key
 * @returns {{name: string, unit: string}}
 */
function _naming(key) {
  let labels = {};
  try {
    labels = readSettingLabels() || {};
  } catch {
    /*- A missing labels file must not turn a rejected value into a
     *  failed request; the key on its own still identifies the
     *  setting. */
  }
  const entry = labels[key];
  return {
    name: entry && entry.label ? entry.label : key,
    unit: entry && entry.unit ? entry.unit : "",
  };
}

/*- The half of every message that says what would have been accepted. */
function _rangeText(bound, unit) {
  return `Enter ${boundText(bound)}${unit}.`;
}

/**
 * Check one numeric setting against its declared interval.
 *
 * Whether the value is accepted is `withinBound`'s answer, the rule every
 * range is judged by. The rest only says why a refused value was refused.
 *
 * @param {*} value
 * @param {string} key
 * @returns {string|null} The problem, in the operator's words, or null.
 */
function _checkNumber(value, key) {
  const bound = BOUNDS[key];
  if (withinBound(value, bound)) return null;
  const { name, unit } = _naming(key);
  if (typeof value !== "number" || !Number.isFinite(value))
    return `${name} must be a number. ${_rangeText(bound, unit)}`;
  if (bound.integer === true && !Number.isInteger(value))
    return `${name} must be a whole number. ${_rangeText(bound, unit)}`;
  return (
    `${name} is ${value}${unit}, which is outside what it accepts. ` +
    _rangeText(bound, unit)
  );
}

/*- A token price the operator supplies because auto-detection failed.
 *  Zero is how the dialog clears one — every reader gates on
 *  `priceOverride > 0` — so zero is accepted and only a negative or a
 *  non-number is refused. */
function _checkPriceOverride(value, key) {
  const { name } = _naming(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return `${name} must be a price of zero or more. Zero clears it.`;
  if (!withinBound(value, SETTING_BOUNDS.priceOverride))
    return `${name} is above any price a token has had.`;
  return null;
}

/*- The auto-compound threshold cannot sit below the fee a compound
 *  needs to be worth doing, and that floor is a shipped value the
 *  caller holds, so it arrives as context rather than being declared
 *  twice. */
function _checkCompoundThreshold(value, _key, ctx) {
  const { name } = _naming("autoCompoundThresholdUsd");
  const floor = ctx.compoundMinFeeUsd;
  if (typeof value !== "number" || !Number.isFinite(value))
    return `${name} must be a dollar amount.`;
  if (value < floor)
    return (
      `${name} is $${value}, below the $${floor} of fees a compound ` +
      `needs to be worth its gas. Enter $${floor} or more.`
    );
  if (!withinBound(value, SETTING_BOUNDS.autoCompoundThresholdUsd))
    return `${name} is above any amount a position holds.`;
  return null;
}

/*- Every endpoint the bot may dial. Checked one at a time so the
 *  message can say which one is wrong rather than that one of them
 *  is. */
function _checkRpcUrls(value) {
  if (!Array.isArray(value)) return "The RPC endpoint list must be a list.";
  const count = SETTING_BOUNDS.rpcUrlCount;
  if (!withinBound(value.length, count))
    return (
      `The RPC endpoint list has ${value.length} entries. ` +
      `Enter from ${count.min} to ${count.max}.`
    );
  for (const url of value) {
    /*- A fresh copy per call: `isURL` merges its own defaults INTO the
     *  options object it is handed, so passing the frozen declaration
     *  throws rather than answering. */
    if (typeof url !== "string" || !validator.isURL(url, { ..._URL_OPTS }))
      return (
        `"${String(url)}" is not a usable RPC endpoint. An endpoint is a ` +
        `full address beginning http:// or https://, such as ` +
        `https://rpc.example.com.`
      );
  }
  return null;
}

function _checkBoolean(value, key) {
  const { name } = _naming(key);
  return typeof value === "boolean"
    ? null
    : `${name} must be on or off, and arrived as ${String(value)}.`;
}

/*- The date an operator pins a position's lifetime figures to. */
function _checkLifetimeStart(value) {
  return typeof value === "string" && validator.isISO8601(value)
    ? null
    : "The lifetime start date must be a calendar date, such as 2026-01-31.";
}

/*-
 *  Every key `POST /api/config` accepts, and what makes a value
 *  acceptable: each setting the dashboard lets an operator set, and each
 *  record the bot keeps for itself, such as `hodlBaseline`, held to the
 *  shape the bot writes (src/config-record-checks.js).
 */
const RULES = Object.freeze({
  ...Object.fromEntries(Object.keys(BOUNDS).map((k) => [k, _checkNumber])),
  ..._BOOLEAN_KEYS.reduce((acc, k) => ({ ...acc, [k]: _checkBoolean }), {}),
  autoCompoundThresholdUsd: _checkCompoundThreshold,
  priceOverride0: _checkPriceOverride,
  priceOverride1: _checkPriceOverride,
  rpcUrls: _checkRpcUrls,
  lifetimeStartDateOverrideUtc: _checkLifetimeStart,
  ...RECORD_CHECKS,
});

/**
 * Check every value in a config patch.
 *
 * Stops at the first problem, because the dashboard saves one setting
 * at a time and a list of problems has nowhere to go.
 *
 * @param {object} patch  The global and per-position values being saved,
 *   merged. Keys this file does not name are ones the route does not
 *   save, and are left alone.
 * @param {object} [ctx]  A value the caller has already resolved:
 *   `compoundMinFeeUsd`, the fee floor of the auto-compound threshold.
 * @returns {{key: string, message: string}|null} The setting whose value
 *   was refused and what to tell the operator, or null when every value
 *   is acceptable.
 */
function checkConfigValues(patch, ctx = {}) {
  for (const [key, value] of Object.entries(patch || {})) {
    const rule = RULES[key];
    /*- `null` is how the dashboard clears a setting back to the shipped
     *  default — the route deletes the key rather than storing it — so
     *  it is not a value to bound. */
    if (!rule || value === null || value === undefined) continue;
    const message = rule(value, key, ctx);
    if (message) return { key, message };
  }
  return null;
}

module.exports = { checkConfigValues, BOUNDS, RULES };
