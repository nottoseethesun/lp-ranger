/**
 * @file src/config-bounds.js
 * @module configBounds
 * @description
 * The one place that decides whether a value an operator typed into the
 * dashboard may be saved.
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
 * **Where the numbers come from.** A bound already declared in
 * `bot-config-defaults.json` is read from there — `gasFeePctMin/Max`
 * and `impermanentLossGuardPctMin/Max` — so the pair stays in one
 * place. Timer settings are not bounded here at all: they go to
 * `src/timer-bounds.js`, which is the single authority on a value that
 * becomes a `setTimeout` delay and carries its own reasoning.
 */

"use strict";

const validator = require("validator");
const { assertTimerSec } = require("./timer-bounds");
const { loadShippedDefaults } = require("./load-merged-defaults");
const { readSettingLabels } = require("./setting-labels");

const _SHIPPED = Object.freeze(loadShippedDefaults("bot-config-defaults.json"));

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

/*- How many endpoints the failover list may hold. One is the minimum
 *  that can serve a request at all; ten is past any use, and the list
 *  is walked in order on every outage. */
const RPC_URL_COUNT = Object.freeze({ min: 1, max: 10 });

/**
 * Ranges for the settings whose acceptable values are a plain numeric
 * interval. Exported so `src/bot-config-defaults.js` clamps the shipped
 * file against the same figures this refuses an operator's value
 * against — one declaration, two policies.
 */
const BOUNDS = Object.freeze({
  /*- 0 means the OOR timeout is off. A day is past the point where a
   *  position left out of range is being managed at all. */
  rebalanceTimeoutMin: Object.freeze({ min: 0, max: 1440, integer: true }),
  /*- A week. Longer is indistinguishable from not rebalancing. */
  minRebalanceIntervalMin: Object.freeze({ min: 1, max: 10080, integer: true }),
  maxRebalancesPerDay: Object.freeze({ min: 1, max: 12, integer: true }),
  impermanentLossGuardPct: Object.freeze({
    min: _SHIPPED.impermanentLossGuardPctMin,
    max: _SHIPPED.impermanentLossGuardPctMax,
    integer: true,
  }),
  /*- Not required to be whole: the dashboard has always accepted a
   *  fractional threshold here, and this must not refuse a value the
   *  form could already save. */
  rebalanceOutOfRangeThresholdPercent: Object.freeze({ min: 1, max: 100 }),
  /*- 200 is the mathematical ceiling — `computeNewRange` reads W as
   *  ±W/2% around the price, so 200 is ±100% and anything above it
   *  rounds to the same degenerate range. */
  rebalanceRangeWidthPct: Object.freeze({ min: 0.1, max: 200 }),
  offsetToken0Pct: Object.freeze({ min: 0, max: 100, integer: true }),
  slippagePctToken0: Object.freeze({ min: 0.1, max: 20 }),
  slippagePctToken1: Object.freeze({ min: 0.1, max: 20 }),
  approvalMultiple: Object.freeze({ min: 1, max: 1_000_000, integer: true }),
  gasFeePct: Object.freeze({
    min: _SHIPPED.gasFeePctMin,
    max: _SHIPPED.gasFeePctMax,
  }),
  /*- A figure the operator types to describe money already spent, so
   *  the only wrong values are negative ones and ones no wallet holds. */
  initialDepositUsd: Object.freeze({ min: 0, max: 1e12 }),
  /*- ERC-20 decimals. The ceiling is the app's own, from
   *  `_parseDecimals` in `public/dashboard-token-decimals.js`, which has
   *  called [0, 77] a valid decimals since that form was written. A
   *  second, tighter figure here would refuse a value the form itself
   *  had already written to localStorage, leaving the two disagreeing
   *  about the same token. */
  decimalsOverride0: Object.freeze({ min: 0, max: 77, integer: true }),
  decimalsOverride1: Object.freeze({ min: 0, max: 77, integer: true }),
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
function _rangeText({ min, max, integer }, unit) {
  const lead = integer ? "Enter a whole number" : "Enter a value";
  return `${lead} from ${min} to ${max}${unit}.`;
}

/**
 * Check one numeric setting against its declared interval.
 *
 * @param {*} value
 * @param {string} key
 * @returns {string|null} The problem, in the operator's words, or null.
 */
function _checkNumber(value, key) {
  const bound = BOUNDS[key];
  const { name, unit } = _naming(key);
  if (typeof value !== "number" || !Number.isFinite(value))
    return `${name} must be a number. ${_rangeText(bound, unit)}`;
  if (bound.integer && !Number.isInteger(value))
    return `${name} must be a whole number. ${_rangeText(bound, unit)}`;
  if (value < bound.min || value > bound.max)
    return (
      `${name} is ${value}${unit}, which is outside what it accepts. ` +
      _rangeText(bound, unit)
    );
  return null;
}

/*- A token price the operator supplies because auto-detection failed.
 *  Zero is how the dialog clears one — every reader gates on
 *  `priceOverride > 0` — so zero is accepted and only a negative or a
 *  non-number is refused. */
function _checkPriceOverride(value, key) {
  const { name } = _naming(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return `${name} must be a price of zero or more. Zero clears it.`;
  if (value > 1e12) return `${name} is above any price a token has had.`;
  return null;
}

/*- The auto-compound threshold cannot sit below the fee a compound
 *  needs to be worth doing, and that floor is a shipped value the
 *  caller holds, so it arrives as context rather than being declared
 *  twice. */
function _checkCompoundThreshold(value, _key, ctx) {
  const { name } = _naming("autoCompoundThresholdUsd");
  const floor =
    typeof ctx.compoundMinFeeUsd === "number" &&
    Number.isFinite(ctx.compoundMinFeeUsd)
      ? ctx.compoundMinFeeUsd
      : 0;
  if (typeof value !== "number" || !Number.isFinite(value))
    return `${name} must be a dollar amount.`;
  if (value < floor)
    return (
      `${name} is $${value}, below the $${floor} of fees a compound ` +
      `needs to be worth its gas. Enter $${floor} or more.`
    );
  if (value > 1e9) return `${name} is above any amount a position holds.`;
  return null;
}

/*- Every endpoint the bot may dial. Checked one at a time so the
 *  message can say which one is wrong rather than that one of them
 *  is. */
function _checkRpcUrls(value) {
  if (!Array.isArray(value)) return "The RPC endpoint list must be a list.";
  if (value.length < RPC_URL_COUNT.min || value.length > RPC_URL_COUNT.max)
    return (
      `The RPC endpoint list has ${value.length} entries. ` +
      `Enter from ${RPC_URL_COUNT.min} to ${RPC_URL_COUNT.max}.`
    );
  for (const url of value) {
    /*- A fresh copy per call: `isURL` merges its own defaults INTO the
     *  options object it is handed, so passing the frozen declaration
     *  throws rather than answering. */
    if (typeof url !== "string" || !validator.isURL(url, { ..._URL_OPTS }))
      return (
        `"${String(url)}" is not a usable RPC endpoint. An endpoint is a ` +
        `full address beginning http:// or https://, such as ` +
        `https://rpc.pulsechain.com.`
      );
  }
  return null;
}

/*- A timer setting is `src/timer-bounds.js`'s question, not this
 *  file's. The shipped default it bounds against comes from the caller,
 *  which is the tier that has read the config. */
function _checkTimer(value, key, ctx) {
  try {
    assertTimerSec({
      sec: value,
      key,
      defaultSec: ctx.defaultsSec ? ctx.defaultsSec[key] : undefined,
      label: _naming(key).name,
      remedy: "Choose a value within range and save again.",
    });
    return null;
  } catch (err) {
    /*- Caught rather than propagated: the route can answer, and the
     *  server has every other request to go on serving. */
    return err.message;
  }
}

function _checkBoolean(value, key) {
  const { name } = _naming(key);
  return typeof value === "boolean"
    ? null
    : `${name} must be on or off, and arrived as ${String(value)}.`;
}

function _checkGasStrategy(value) {
  const { name } = _naming("gasStrategy");
  return value === "auto" ? null : `${name} accepts only "auto".`;
}

/*- The date an operator pins a position's lifetime figures to. */
function _checkLifetimeStart(value) {
  return typeof value === "string" && validator.isISO8601(value)
    ? null
    : "The lifetime start date must be a calendar date, such as 2026-01-31.";
}

/*- Every setting the dashboard lets an operator set, and what makes a
 *  value acceptable. A key absent from here is one no form writes —
 *  app-maintained state such as `hodlBaseline` — and is left alone. */
const RULES = Object.freeze({
  ...Object.fromEntries(Object.keys(BOUNDS).map((k) => [k, _checkNumber])),
  ..._BOOLEAN_KEYS.reduce((acc, k) => ({ ...acc, [k]: _checkBoolean }), {}),
  checkIntervalSec: _checkTimer,
  autoCompoundThresholdUsd: _checkCompoundThreshold,
  priceOverride0: _checkPriceOverride,
  priceOverride1: _checkPriceOverride,
  rpcUrls: _checkRpcUrls,
  gasStrategy: _checkGasStrategy,
  lifetimeStartDateOverrideUtc: _checkLifetimeStart,
});

/**
 * Check every dashboard-settable value in a config patch.
 *
 * Stops at the first problem, because the dashboard saves one setting
 * at a time and a list of problems has nowhere to go.
 *
 * @param {object} patch  The global and per-position values being saved,
 *   merged. Keys this file does not name are left alone.
 * @param {object} [ctx]  Values the caller has already resolved:
 *   `defaultsSec` (shipped defaults for timer settings, keyed the same
 *   way) and `compoundMinFeeUsd`.
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

module.exports = { checkConfigValues, BOUNDS };
