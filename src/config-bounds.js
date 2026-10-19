/**
 * @file src/config-bounds.js
 * @module configBounds
 * @description
 * What each setting in bot-config.json may be, as JSON Schema, and the
 * one place that decides whether a value an operator typed into the
 * dashboard may be saved, and with it any value `POST /api/config` is
 * sent.
 *
 * Each setting's schema is written once and serves twice. A save is held
 * to it here (`checkConfigValues`), and the startup check builds
 * bot-config.json's schema from it (`settingSchemas`, read by
 * src/bot-config-checks.js), so a value a save would refuse stops
 * startup and one a save would take passes.
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
 * setting in `invalidValueForKey`, with words that name the setting as
 * the dashboard labels it and say what it accepts, and the dashboard
 * fills the field again from the server's answer.
 *
 * **Where the numbers come from.** Every range is read from
 * `setting-bounds.json` through `src/setting-bounds.js`, which also
 * gives `src/bot-config-defaults.js` the same figures for the shipped
 * file's own values: one declaration, two policies. No setting that
 * becomes a `setTimeout` delay is saved from the dashboard; where one is
 * read, `src/timer-bounds.js` is the single authority on it.
 */

"use strict";

const { SETTING_BOUNDS } = require("./setting-bounds");
const { boundText } = require("./range-check");
const { readSettingLabels } = require("./setting-labels");
const { KINDS, AJV, isNumber } = require("./value-kinds");
const { inRange } = require("./settings-schema-parts");

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

/*-
 *  A token price the operator supplies because auto-detection failed.
 *  Zero is how the dialog clears one — every reader gates on
 *  `priceOverride > 0` — so zero is accepted.
 */
const _PRICE_OVERRIDE = Object.freeze(inRange(SETTING_BOUNDS.priceOverride));

/*- Every endpoint the bot may dial, as many as the list may hold. */
const _RPC_COUNT = SETTING_BOUNDS.rpcUrlCount;
const _RPC_URLS = Object.freeze({
  type: "array",
  minItems: _RPC_COUNT.min,
  maxItems: _RPC_COUNT.max,
  items: KINDS.rpcUrl.schema,
  description: `a list of ${_RPC_COUNT.min} to ${_RPC_COUNT.max} RPC endpoints`,
});

/*-
 *  The auto-compound threshold cannot sit below the fee a compound
 *  needs to be worth doing. That floor is a shipped value the caller
 *  holds, so it arrives as context rather than being declared twice; a
 *  caller without one leaves the threshold no floor.
 */
function _thresholdSchema(floor) {
  const bound = SETTING_BOUNDS.autoCompoundThresholdUsd;
  return inRange(isNumber(floor) ? { ...bound, min: floor } : bound);
}

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

/*-
 *  Why a value was refused, in the operator's words. Each is asked only
 *  once the setting's schema has refused the value, and says which part
 *  of the rule the value missed.
 */

function _numberWords(value, key) {
  const bound = BOUNDS[key];
  const { name, unit } = _naming(key);
  if (!isNumber(value))
    return `${name} must be a number. ${_rangeText(bound, unit)}`;
  if (bound.integer === true && !Number.isInteger(value))
    return `${name} must be a whole number. ${_rangeText(bound, unit)}`;
  return (
    `${name} is ${value}${unit}, which is outside what it accepts. ` +
    _rangeText(bound, unit)
  );
}

function _priceOverrideWords(value, key) {
  const { name } = _naming(key);
  if (!isNumber(value) || value < 0)
    return `${name} must be a price of zero or more. Zero clears it.`;
  return `${name} is above any price a token has had.`;
}

function _thresholdWords(value, key, ctx) {
  const { name } = _naming(key);
  const floor = ctx.compoundMinFeeUsd;
  if (!isNumber(value)) return `${name} must be a dollar amount.`;
  if (value < floor)
    return (
      `${name} is $${value}, below the $${floor} of fees a compound ` +
      `needs to be worth its gas. Enter $${floor} or more.`
    );
  return `${name} is above any amount a position holds.`;
}

/*- Names the endpoint that is wrong, rather than saying one of them is. */
function _rpcUrlsWords(value) {
  if (!Array.isArray(value)) return "The RPC endpoint list must be a list.";
  const bad = value.find((url) => !KINDS.rpcUrl.ok(url));
  if (bad === undefined)
    return (
      `The RPC endpoint list has ${value.length} entries. ` +
      `Enter from ${_RPC_COUNT.min} to ${_RPC_COUNT.max}.`
    );
  return (
    `"${String(bad)}" is not a usable RPC endpoint. An endpoint is a ` +
    `full address beginning http:// or https://, such as ` +
    `https://rpc.example.com.`
  );
}

function _booleanWords(value, key) {
  const { name } = _naming(key);
  return `${name} must be on or off, and arrived as ${String(value)}.`;
}

/*- The date an operator pins a position's lifetime figures to. */
function _lifetimeStartWords() {
  return "The lifetime start date must be a calendar date, such as 2026-01-31.";
}

/**
 * Each setting `POST /api/config` saves, which is each setting the
 * dashboard lets an operator set: its JSON Schema, and the words for a
 * value the schema refuses.
 *
 * @param {object} ctx  As for `settingSchemas`.
 * @returns {Object<string, {schema: object, words: Function}>}
 */
function _settings(ctx) {
  const each = (keys, schemaOf, words) =>
    Object.fromEntries(keys.map((k) => [k, { schema: schemaOf(k), words }]));
  return {
    ...each(Object.keys(BOUNDS), (k) => inRange(BOUNDS[k]), _numberWords),
    ...each(_BOOLEAN_KEYS, () => KINDS.bool.schema, _booleanWords),
    ...each(
      ["priceOverride0", "priceOverride1"],
      () => _PRICE_OVERRIDE,
      _priceOverrideWords,
    ),
    autoCompoundThresholdUsd: {
      schema: _thresholdSchema(ctx.compoundMinFeeUsd),
      words: _thresholdWords,
    },
    rpcUrls: { schema: _RPC_URLS, words: _rpcUrlsWords },
    lifetimeStartDateOverrideUtc: {
      schema: KINDS.isoTime.schema,
      words: _lifetimeStartWords,
    },
  };
}

/**
 * What each setting in bot-config.json may be, as JSON Schema, by key.
 *
 * @param {object} [ctx]  A value the caller has already resolved:
 *   `compoundMinFeeUsd`, the fee floor of the auto-compound threshold.
 * @returns {Object<string, object>}
 */
function settingSchemas(ctx = {}) {
  return Object.fromEntries(
    Object.entries(_settings(ctx)).map(([k, s]) => [k, s.schema]),
  );
}

/*-
 *  Each setting's schema compiled, for each fee floor a caller has
 *  passed. A running server passes one, so each is compiled once.
 */
const _compiled = new Map();

/** Each setting's compiled schema and its words. */
function _checks(ctx) {
  const floor = ctx.compoundMinFeeUsd;
  if (!_compiled.has(floor))
    _compiled.set(
      floor,
      Object.fromEntries(
        Object.entries(_settings(ctx)).map(([k, s]) => [
          k,
          { ok: AJV.compile(s.schema), words: s.words },
        ]),
      ),
    );
  return _compiled.get(floor);
}

/**
 * Check every value in a config patch against its setting's schema.
 *
 * Stops at the first problem, because the dashboard saves one setting
 * at a time and a list of problems has nowhere to go.
 *
 * @param {object} patch  The global and per-position values being saved,
 *   merged. Keys this file does not name are ones the route does not
 *   save, and are left alone.
 * @param {object} [ctx]  As for `settingSchemas`.
 * @returns {{key: string, message: string}|null} The setting whose value
 *   was refused and what to tell the operator, or null when every value
 *   is acceptable.
 */
function checkConfigValues(patch, ctx = {}) {
  const checks = _checks(ctx);
  for (const [key, value] of Object.entries(patch || {})) {
    /*- `null` is how the dashboard clears a setting back to the shipped
     *  default — the route deletes the key rather than storing it — so
     *  it is not a value to check. */
    if (!Object.hasOwn(checks, key) || value === null || value === undefined)
      continue;
    const { ok, words } = checks[key];
    if (!ok(value)) return { key, message: words(value, key, ctx) };
  }
  return null;
}

module.exports = { checkConfigValues, settingSchemas, BOUNDS };
