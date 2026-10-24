"use strict";

/**
 * @file src/help-figures.js
 * @module help-figures
 * @description
 * The configured numbers and names the help copy quotes, worked out from
 * the values the app runs on, and the ways they are written into that
 * copy.
 *
 * Help that states a setting's default, its range or a timing the app
 * uses must state the figure the app actually holds, so it reads that
 * figure rather than repeating it. The same goes for the chain the app
 * runs on and the aggregator its swaps try first: the help names the
 * ones in chains.json, never one it was written for. The server resolves
 * those values, shipped file, operator override and `.env` in that order,
 * in `src/resolved-settings.js`, and the User Manual's build passes the
 * shipped files alone for the copy GitHub Pages publishes.
 * `helpFigures` takes them as plain objects, numbers and names, and
 * returns one table of named figures, each already worded for a
 * sentence: "15", "4 hours", "10m → 20m → 40m → 80m". Every figure is
 * plain text, so it can be set as a page element's text. The dialogs and
 * the manual also write figures into HTML as they are. The numbers are
 * worded here, with no markup or entity in them; a name is chains.json's
 * own, which only the shipped file and the operator's copy of it set.
 * The examples the copy works through are computed here as well, from
 * the same values, so an example stays true when the default it
 * illustrates changes.
 *
 * The figures reach the copy in two ways, because the copy lives in two
 * kinds of file. Shared help, kept as text in
 * `public/shared-help-content.json` and rendered by both the circle-i
 * dialog and the User Manual, carries `{{figure:name}}` tokens, which
 * `fillEntryFigures` replaces before either renders it: with the figure
 * itself for the dialog, and for the manual with the figure inside
 * `<span data-figure="name">…</span>`. The manual's own prose is HTML
 * edited in place, so each figure there sits in such a span too, whose
 * text `fillFigureSpans` rewrites on every build. Every figure in the
 * manual is therefore in a span, which is what lets the copy the app
 * serves be filled again in the browser with the install's own figures
 * (`public/dashboard-manual-figures.js`). A name the table lacks stops
 * the manual's build with an error, so a typo cannot reach a reader as a
 * raw token; the browser fill only warns.
 *
 * **Dependency-free**, as `src/range-check.js` is: the dashboard bundle
 * imports it for the dialog, and `scripts/build-manual-content.js` for
 * the manual. Add no `require` to this file.
 */

/*-
 *  Units of time, largest first, in seconds. A figure is worded in the
 *  largest unit it fills exactly, so 3600 reads "1 hour" and 4800 reads
 *  "80 minutes".
 */
const _UNITS = [
  ["week", "w", 604800],
  ["day", "d", 86400],
  ["hour", "h", 3600],
  ["minute", "m", 60],
  ["second", "s", 1],
];

/** A whole number of seconds as a count of the largest unit it fills. */
function _unitOf(sec) {
  for (const [name, short, size] of _UNITS)
    if (sec >= size && sec % size === 0) return { n: sec / size, name, short };
  return { n: sec, name: "second", short: "s" };
}

/**
 * A span of time worded for a sentence: "1 hour", "10 minutes".
 * @param {number} sec  Whole seconds.
 * @returns {string}
 */
function duration(sec) {
  const { n, name } = _unitOf(sec);
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

// The words for the counts prose spells out; ten and up are numerals.
const _SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/**
 * A count worded for a sentence: spelled out under ten, as prose spells
 * small numbers, and a numeral from ten up.
 * @param {number} n  A whole number of zero or more.
 * @returns {string}
 */
function count(n) {
  return Number.isInteger(n) && n >= 0 && n < 10 ? _SMALL[n] : String(n);
}

/**
 * A span of time in its short form, for a ladder: "4h", "10m".
 * @param {number} sec  Whole seconds.
 * @returns {string}
 */
function shortDuration(sec) {
  const { n, short } = _unitOf(sec);
  return `${n}${short}`;
}

/**
 * The first `rungs` waits of a doubling ladder that starts at `startSec`,
 * leaving out any rung past `capSec`.
 * @param {number} startSec
 * @param {number} capSec
 * @param {number} rungs
 * @returns {number[]} Seconds.
 */
function _ladder(startSec, capSec, rungs) {
  const out = [];
  for (let k = 0, s = startSec; k < rungs && s <= capSec; k++, s *= 2)
    out.push(s);
  return out;
}

/** A dollar amount with thousands separators: "1,000". */
function _usd(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** A whole number of years, worded for a sentence: "5 years". */
function _years(n) {
  return `${n} year${n === 1 ? "" : "s"}`;
}

/** Requests a second at a minimum gap of `ms` between them: "4.5". */
function _perSecond(ms) {
  return String(Math.round(10_000 / ms) / 10);
}

/*-
 *  The Impermanent Loss Guard's worked example: holding the coins the NFT
 *  was minted with worth this many dollars at today's prices, a position
 *  worth the floor less a fifth of the loss the guard allows (rejected),
 *  and one worth the floor plus two fifths of it (rebalanced). At the
 *  shipped 15% that is $850, $820 and $910.
 */
const _ILG_EXAMPLE_HOLD_USD = 1000;

/**
 * The worked example's rejected position, as the clause the help ends on.
 *
 * The position is worth the floor less a fifth of the loss the guard
 * allows, but never less than half the floor, so the figure stays above
 * $0 at every setting. A guard of 100% puts the floor at $0, which no
 * position can come out below, so there the clause says the guard never
 * rejects one.
 *
 * @param {number} floor        The floor, in dollars.
 * @param {number} allowedLoss  The loss the guard allows, in dollars.
 * @returns {string} The clause, with no closing full stop.
 */
function _ilgExampleRejected(floor, allowedLoss) {
  if (floor <= 0)
    return (
      "no position can come out below $0, so at this setting the Guard " +
      "never rejects one"
    );
  const rejected = Math.max(floor - allowedLoss / 5, floor / 2);
  return `at $${_usd(rejected)} it is rejected and left alone`;
}

/**
 * Every figure the help copy quotes, worded for a sentence.
 *
 * Takes values already resolved, whichever way the caller resolves them:
 * the manual's build passes the shipped files, and the server passes what
 * the install runs on, its operator's overrides and `.env` included. The
 * three timings arrive as plain numbers for the same reason: `.env` can
 * set each, and the cancel delay is derived when it does not.
 *
 * @param {object} values
 * @param {object} values.botDefaults    bot-config-defaults.json, resolved.
 * @param {object} values.settingBounds  setting-bounds.json.
 * @param {object} values.uiDefaults     The dashboard settings the server
 *   sends, from ui-defaults_non-layout_for-server-up-scenario.json.
 * @param {object} values.appRuntime     app-runtime.json, resolved.
 * @param {number} values.txSpeedupSec   Seconds before a speed-up.
 * @param {number} values.txCancelSec    Seconds before a cancel.
 * @param {number} values.compoundMinFeeUsd  Least fees a compound takes.
 * @param {string} values.chainKey   The chain's key in chains.json, which
 *   a position's address in the browser begins with.
 * @param {string} values.chainName  The chain's `displayName`.
 * @param {string} values.aggregatorName  The name of the aggregator the
 *   chain's swaps try first, or "" when it has none
 *   (`src/aggregator-in-use.js`).
 * @returns {Readonly<Record<string, string>>} Figure name to its wording.
 */
function helpFigures({
  botDefaults,
  settingBounds,
  uiDefaults,
  appRuntime,
  txSpeedupSec,
  txCancelSec,
  compoundMinFeeUsd,
  chainKey,
  chainName,
  aggregatorName,
}) {
  const { poll, retire, compound } = appRuntime;
  const dbl = botDefaults.throttleDoubling;
  const intervalSec = botDefaults.minRebalanceIntervalMin * 60;
  const retry = botDefaults.ilGuardRetry;
  const guard = botDefaults.impermanentLossGuardPct;
  const allowedLoss = (_ILG_EXAMPLE_HOLD_USD * guard) / 100;
  const floor = _ILG_EXAMPLE_HOLD_USD - allowedLoss;
  const dailyCap = botDefaults.maxRebalancesPerDay;
  const nearAt = Math.ceil((dailyCap * uiDefaults.throttleNearLimitPct) / 100);
  return Object.freeze({
    minRebalanceInterval: duration(intervalSec),
    // Prose counts rebalances, so small ones are spelled out: "three".
    doublingTriggerCount: count(dbl.triggerCount),
    doublingTriggerWindowMultiple: String(dbl.triggerWindowMultiple),
    doublingQuietWindowMultiple: String(dbl.quietWindowMultiple),
    doublingTriggerWindowExample: duration(
      dbl.triggerWindowMultiple * intervalSec,
    ),
    doublingLadder: _ladder(intervalSec, Infinity, 4)
      .map(shortDuration)
      .join(" → "),
    /*-
     *  The clearing rule worked at the minimum interval: once doubled,
     *  the cooldown is twice it, and doubling clears after a quiet spell
     *  of the quiet multiple times that.
     */
    doublingExampleDoubledWait: duration(2 * intervalSec),
    doublingExampleQuiet: duration(dbl.quietWindowMultiple * 2 * intervalSec),
    dailyCapDefault: String(dailyCap),
    /*-
     *  The NEAR LIMIT badge's threshold, and when it shows at the daily
     *  cap: after this many rebalances, with this many left.
     */
    nearLimitPct: String(uiDefaults.throttleNearLimitPct),
    nearLimitExampleCap: count(dailyCap),
    nearLimitExampleAt: count(nearAt),
    nearLimitExampleLeft: count(dailyCap - nearAt),
    ilgDefaultPct: String(guard),
    ilgExampleHoldUsd: _usd(_ILG_EXAMPLE_HOLD_USD),
    ilgExampleFloorUsd: _usd(floor),
    ilgExampleAboveUsd: _usd(floor + (allowedLoss * 2) / 5),
    ilgExampleRejected: _ilgExampleRejected(floor, allowedLoss),
    ilgRetryFirst: duration(retry.baseMs / 1000),
    ilgRetryLadder: _ladder(retry.baseMs / 1000, retry.maxMs / 1000, 4)
      .map(shortDuration)
      .join(", "),
    ilgRetryCeiling: duration(retry.maxMs / 1000),
    oorThresholdDefaultPct: String(
      botDefaults.rebalanceOutOfRangeThresholdPercent,
    ),
    /*-
     *  0 turns the timeout off, which the help says in words rather than
     *  as a duration of none.
     */
    oorTimeoutDefault:
      botDefaults.rebalanceTimeoutMin === 0
        ? "Turned Off"
        : duration(botDefaults.rebalanceTimeoutMin * 60),
    slippageDefaultPct: String(botDefaults.slippagePct),
    slippageMinPct: String(settingBounds.slippagePctToken0.min),
    slippageMaxPct: String(settingBounds.slippagePctToken0.max),
    slippageConfirmAbovePct: String(uiDefaults.slippageConfirmAbovePct),
    slippageTypedConfirmFromPct: String(uiDefaults.slippageTypedConfirmFromPct),
    gasFeeDefaultPct: String(botDefaults.gasFeePct),
    rebalanceGasDeferPct: String(botDefaults.rebalanceGasDeferPct),
    gasDeferRetry: duration(botDefaults.gasDeferRetrySec),
    checkInterval: duration(botDefaults.checkIntervalSec),
    rpcFailoverSticky: duration(botDefaults.rpcFailoverStickyMs / 1000),
    dashboardPollInterval: duration(uiDefaults.dashboardPollIntervalMs / 1000),
    checkIntervalSec: String(botDefaults.checkIntervalSec),
    historyLookback: _years(botDefaults.historyLookbackYears),
    rpcPaceGapMs: String(botDefaults.globalRPCRequestRateIntervalMS),
    rpcPacePerSecond: _perSecond(botDefaults.globalRPCRequestRateIntervalMS),
    rpcPaceMinMs: String(
      settingBounds.timers.settings.globalRPCRequestRateIntervalMS.min,
    ),
    rpcPaceMaxMs: String(
      settingBounds.timers.settings.globalRPCRequestRateIntervalMS.max,
    ),
    residualCleanupDelay: duration(botDefaults.residualCleanup.delayMs / 1000),
    residualCleanupThresholdPct: String(
      botDefaults.residualCleanup.thresholdPct,
    ),
    offsetDefaultPct: String(botDefaults.offsetToken0Pct),
    lowGasSafetyMultiple: String(botDefaults.lowGasThresholds.safetyMultiplier),
    approvalMultipleDefault: String(botDefaults.approvalMultiple),
    compoundMinFeeUsd: String(compoundMinFeeUsd),
    /*-
     *  The least time between two automatic compounds: the spacing in
     *  polls at the poll interval, never under the floor.
     */
    compoundSpacing: duration(
      Math.max(
        compound.autoSpacingPolls * botDefaults.checkIntervalSec,
        compound.autoSpacingFloorSec,
      ),
    ),
    drainedRetire: duration(retire.drainedAfterMs / 1000),
    lifetimeRescanRetry: duration(poll.lifetimeRescanCheckMs / 1000),
    txSpeedup: duration(txSpeedupSec),
    txSpeedupSec: String(txSpeedupSec),
    txCancel: duration(txCancelSec),
    txCancelSec: String(txCancelSec),
    chainKey,
    chainName,
    /*-
     *  The aggregator's name, "" on a chain with none, for copy that
     *  words the two cases apart. The manual's prose cannot, so it
     *  quotes `aggregatorInUse`, which reads "none" there.
     */
    aggregatorName,
    aggregatorInUse: aggregatorName === "" ? "none" : aggregatorName,
  });
}

/** The wording of figure `name`, or an error naming it. */
function _figure(figures, name) {
  if (Object.prototype.hasOwnProperty.call(figures, name)) return figures[name];
  throw new Error(`help copy names a figure that does not exist: ${name}`);
}

/**
 * Replace every `{{figure:name}}` token in `text` with its figure.
 * Other `{{…}}` tokens, such as the dialog's `{{token0}}`, are left for
 * their own owner.
 * @param {string} text
 * @param {Record<string, string>} figures  From `helpFigures`.
 * @returns {string}
 * @throws {Error} When a token names no figure.
 */
function fillFigureTokens(text, figures) {
  return text.replace(/\{\{figure:([A-Za-z0-9]+)\}\}/g, (_m, name) =>
    _figure(figures, name),
  );
}

/**
 * Replace every `{{figure:name}}` token in `text` with its figure inside
 * `<span data-figure="name">…</span>`, for HTML whose figures are filled
 * again later, as the manual's are in the browser.
 * @param {string} text
 * @param {Record<string, string>} figures  From `helpFigures`.
 * @returns {string}
 * @throws {Error} When a token names no figure.
 */
function spanFigureTokens(text, figures) {
  return text.replace(
    /\{\{figure:([A-Za-z0-9]+)\}\}/g,
    (_m, name) =>
      `<span data-figure="${name}">${_figure(figures, name)}</span>`,
  );
}

/**
 * A shared help entry with every figure token in its title, subtitle,
 * headings and bodies filled in. The entry itself is left as it was.
 * @param {object} entry  An entry of shared-help-content.json.
 * @param {Record<string, string>} figures  From `helpFigures`.
 * @param {Function} [fillText]  How a token is filled:
 *   `fillFigureTokens` unless the caller passes `spanFigureTokens`.
 * @returns {object}
 */
function fillEntryFigures(entry, figures, fillText = fillFigureTokens) {
  const fill = (s) => (typeof s === "string" ? fillText(s, figures) : s);
  return {
    ...entry,
    title: fill(entry.title),
    subtitle: fill(entry.subtitle),
    sections: entry.sections.map((s) => ({
      ...s,
      heading: fill(s.heading),
      body: fill(s.body),
    })),
  };
}

/**
 * Rewrite the text of every `<span data-figure="name">…</span>` in `html`
 * with its figure, so a document edited in place carries the current
 * figure after every build, however often the build runs.
 * @param {string} html
 * @param {Record<string, string>} figures  From `helpFigures`.
 * @returns {string}
 * @throws {Error} When a span names no figure.
 */
function fillFigureSpans(html, figures) {
  return html.replace(
    /<span data-figure="([A-Za-z0-9]+)">[^<]*<\/span>/g,
    (_m, name) =>
      `<span data-figure="${name}">${_figure(figures, name)}</span>`,
  );
}

module.exports = {
  helpFigures,
  fillFigureTokens,
  spanFigureTokens,
  fillEntryFigures,
  fillFigureSpans,
  duration,
  shortDuration,
  count,
};
