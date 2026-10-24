"use strict";

/**
 * @file test/help-figures.test.js
 * @description The configured numbers the help quotes are worked out
 *   from the files that set them, worded for a sentence, and written into
 *   the copy only under names that exist.
 *
 *   The circle-i dialogs and the User Manual both quote these figures, and
 *   both take them from `src/lib/help-figures.js`. A figure the copy typed in
 *   instead goes stale the day the setting changes, and the help then
 *   states a figure the app does not use. A figure named wrongly must
 *   stop the build, rather than reach a reader as a raw token.
 *
 *   The shipped files read here are a copy with every value the help
 *   quotes moved (`helpers/help-settings-moved.js`), so a figure typed
 *   into the code fails. That the manual on disk states the real shipped
 *   figures is checked in `help-manual-figures.test.js`.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { useMovedHelpSettings } = require("./helpers/help-settings-moved");

const { BOT, UI, RUNTIME, CHAINS } = useMovedHelpSettings();
const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const {
  helpFigures,
  fillFigureTokens,
  spanFigureTokens,
  fillEntryFigures,
  fillFigureSpans,
  duration,
  shortDuration,
  count,
} = require("../src/lib/help-figures");

const { shippedFigures } = require("../scripts/build-manual-content");

// The table the manual's build works out from the shipped files, here the copy.
const F = shippedFigures();

/** A dollar figure as a number: "1,000" → 1000. */
const dollars = (s) => Number(s.replace(/,/g, ""));

/** The dollar figure in the Guard example's rejected clause. */
function rejectedUsd(clause) {
  const found = /\$([\d,]+)/.exec(clause);
  assert.ok(found, `no dollar figure in ${JSON.stringify(clause)}`);
  return dollars(found[1]);
}

/** The figures of an install whose default Guard is `pct` percent. */
const figuresAtGuard = (pct) =>
  helpFigures({
    botDefaults: { ...BOT, impermanentLossGuardPct: pct },
    settingBounds: BOUNDS,
    uiDefaults: UI,
    appRuntime: RUNTIME,
  });

describe("a span of time", () => {
  it("is worded in the largest unit it fills exactly", () => {
    assert.equal(duration(3600), "1 hour");
    assert.equal(duration(4800), "80 minutes");
    assert.equal(duration(604800), "1 week");
    assert.equal(duration(120), "2 minutes");
  });

  it("has a short form for a ladder", () => {
    assert.equal(shortDuration(14400), "4h");
    assert.equal(shortDuration(600), "10m");
  });
});

describe("a count", () => {
  it("is spelled out under ten, as prose spells small numbers", () => {
    assert.equal(count(0), "zero");
    assert.equal(count(1), "one");
    assert.equal(count(4), "four");
    assert.equal(count(9), "nine");
  });

  it("is a numeral from ten up", () => {
    assert.equal(count(10), "10");
    assert.equal(count(12), "12");
  });
});

describe("the figures", () => {
  it("are read from the file that sets each one", () => {
    assert.equal(F.ilgDefaultPct, String(BOT.impermanentLossGuardPct));
    assert.equal(F.rebalanceGasDeferPct, String(BOT.rebalanceGasDeferPct));
    assert.equal(F.gasDeferRetry, duration(BOT.gasDeferRetrySec));
    assert.equal(F.slippageMinPct, String(BOUNDS.slippagePctToken0.min));
    assert.equal(F.slippageMaxPct, String(BOUNDS.slippagePctToken0.max));
    assert.equal(
      F.slippageTypedConfirmFromPct,
      String(UI.slippageTypedConfirmFromPct),
    );
    assert.equal(F.compoundMinFeeUsd, String(RUNTIME.compound.minFeeUsd));
    assert.equal(F.txSpeedupSec, String(RUNTIME.tx.speedupSec));
    assert.equal(F.historyLookback, `${BOT.historyLookbackYears} years`);
    assert.equal(F.rpcPaceGapMs, String(BOT.globalRPCRequestRateIntervalMS));
    assert.equal(F.approvalMultipleDefault, String(BOT.approvalMultiple));
  });

  it("name the chain an install ships set to, and its aggregator, from chains.json", () => {
    const key = RUNTIME.defaults.chain;
    assert.equal(F.chainKey, key);
    assert.equal(F.chainName, CHAINS[key].displayName);
    assert.ok(CHAINS[key].aggregator.url.length > 0, "it has an aggregator");
    assert.equal(F.aggregatorName, CHAINS[key].aggregator.name);
    assert.equal(F.aggregatorInUse, CHAINS[key].aggregator.name);
  });

  it("say a chain with no aggregator has none", () => {
    const g = helpFigures({
      botDefaults: BOT,
      settingBounds: BOUNDS,
      uiDefaults: UI,
      appRuntime: RUNTIME,
      chainKey: "testchain",
      chainName: "Testchain",
      aggregatorName: "",
    });
    assert.equal(g.aggregatorName, "");
    assert.equal(g.aggregatorInUse, "none");
    assert.equal(g.chainName, "Testchain");
    assert.equal(g.chainKey, "testchain");
  });

  it("give the request pace as requests a second, to one decimal", () => {
    // 1000 ms over the gap: the shipped 222 ms is about 4.5.
    const perSecond = Number(F.rpcPacePerSecond);
    assert.ok(
      Math.abs(perSecond - 1000 / BOT.globalRPCRequestRateIntervalMS) <= 0.05,
    );
  });

  it("give the cancel wait TX_CANCEL_SEC defaults to: the deadline times its multiple", () => {
    const sec = RUNTIME.tx.deadlineSec * RUNTIME.tx.cancelToDeadlineMultiple;
    assert.equal(F.txCancelSec, String(sec));
    assert.equal(F.txCancel, duration(sec));
  });

  it("say an OOR timeout of 0 is Turned Off, not a duration of none", () => {
    // The user, 2026-10-18: 0 means "Turned Off", worded so in the UI.
    const at = (rebalanceTimeoutMin) =>
      helpFigures({
        botDefaults: { ...BOT, rebalanceTimeoutMin },
        settingBounds: BOUNDS,
        uiDefaults: UI,
        appRuntime: RUNTIME,
      }).oorTimeoutDefault;
    assert.equal(at(0), "Turned Off");
    assert.equal(at(90), "90 minutes");
  });

  it("quote the timings they are given, as an install resolves them", () => {
    /*-
     *  `.env` can set each timing, so the server passes them as numbers
     *  rather than as a file the figures would derive them from again.
     */
    const g = helpFigures({
      botDefaults: BOT,
      settingBounds: BOUNDS,
      uiDefaults: UI,
      appRuntime: RUNTIME,
      txSpeedupSec: 90,
      txCancelSec: 7200,
      compoundMinFeeUsd: 3,
    });
    assert.equal(g.txSpeedup, "90 seconds");
    assert.equal(g.txCancel, "2 hours");
    assert.equal(g.txCancelSec, "7200");
    assert.equal(g.compoundMinFeeUsd, "3");
  });

  it("quote app-runtime.json's retry, retire and spacing timings as given", () => {
    /*-
     *  Each moved off its shipped value, so a figure written into the
     *  code would not match.
     */
    const g = helpFigures({
      botDefaults: { ...BOT, checkIntervalSec: 600 },
      settingBounds: BOUNDS,
      uiDefaults: UI,
      appRuntime: {
        ...RUNTIME,
        poll: { ...RUNTIME.poll, lifetimeRescanCheckMs: 3600000 },
        retire: { drainedAfterMs: 5400000 },
        compound: {
          ...RUNTIME.compound,
          autoSpacingPolls: 3,
          autoSpacingFloorSec: 60,
        },
      },
      txSpeedupSec: 90,
      txCancelSec: 7200,
      compoundMinFeeUsd: 3,
    });
    assert.equal(g.lifetimeRescanRetry, "1 hour");
    assert.equal(g.drainedRetire, "90 minutes");
    // Three polls of 600 s, over the 60 s floor.
    assert.equal(g.compoundSpacing, "30 minutes");
  });

  it("keep automatic compounds at least the floor apart, however short the poll", () => {
    const g = helpFigures({
      botDefaults: { ...BOT, checkIntervalSec: 10 },
      settingBounds: BOUNDS,
      uiDefaults: UI,
      appRuntime: {
        ...RUNTIME,
        compound: {
          ...RUNTIME.compound,
          autoSpacingPolls: 2,
          autoSpacingFloorSec: 900,
        },
      },
      txSpeedupSec: 90,
      txCancelSec: 7200,
      compoundMinFeeUsd: 3,
    });
    assert.equal(g.compoundSpacing, "15 minutes");
  });

  it("work the NEAR LIMIT example at the daily cap, small counts spelled out", () => {
    const cap = BOT.maxRebalancesPerDay;
    const at = Math.ceil((cap * UI.throttleNearLimitPct) / 100);
    assert.equal(F.dailyCapDefault, String(cap));
    assert.equal(F.nearLimitPct, String(UI.throttleNearLimitPct));
    assert.equal(F.nearLimitExampleCap, count(cap));
    assert.equal(F.nearLimitExampleAt, count(at));
    assert.equal(F.nearLimitExampleLeft, count(cap - at));
  });

  it("work the doubling clear-out example at the minimum interval", () => {
    const start = BOT.minRebalanceIntervalMin * 60;
    assert.equal(F.doublingExampleDoubledWait, duration(2 * start));
    assert.equal(
      F.doublingExampleQuiet,
      duration(BOT.throttleDoubling.quietWindowMultiple * 2 * start),
    );
    assert.equal(F.checkIntervalSec, String(BOT.checkIntervalSec));
  });

  it("work the doubling ladder from the minimum interval", () => {
    const start = BOT.minRebalanceIntervalMin * 60;
    const rungs = [start, start * 2, start * 4, start * 8].map(shortDuration);
    assert.equal(F.doublingLadder, rungs.join(" → "));
    assert.equal(
      F.doublingTriggerWindowExample,
      duration(BOT.throttleDoubling.triggerWindowMultiple * start),
    );
  });

  it("work the Impermanent Loss Guard's example from its default", () => {
    /*-
     *  The floor is holding's value less the guard's share of it; the
     *  position that rebalances sits between the floor and holding, and
     *  the one rejected sits below the floor.
     */
    const hold = dollars(F.ilgExampleHoldUsd);
    const floor = dollars(F.ilgExampleFloorUsd);
    assert.equal(floor, hold * (1 - BOT.impermanentLossGuardPct / 100));
    assert.ok(dollars(F.ilgExampleAboveUsd) > floor);
    assert.ok(dollars(F.ilgExampleAboveUsd) < hold);
    const rejected = rejectedUsd(F.ilgExampleRejected);
    assert.ok(rejected < floor);
    assert.ok(rejected > 0);
  });

  it("keep the Guard's rejected example above $0 at every setting", () => {
    // Every whole percentage the Guard's range allows below 100.
    const { min } = BOUNDS.impermanentLossGuardPct;
    for (let pct = min; pct < 100; pct++) {
      const g = figuresAtGuard(pct);
      const rejected = rejectedUsd(g.ilgExampleRejected);
      const floor = dollars(g.ilgExampleFloorUsd);
      assert.ok(rejected > 0, `${pct}%: rejected at $${rejected}`);
      assert.ok(rejected < floor, `${pct}%: $${rejected}, floor $${floor}`);
    }
    // Past where a fifth of the allowed loss would reach $0, half the floor.
    assert.equal(rejectedUsd(figuresAtGuard(84).ilgExampleRejected), 80);
    assert.equal(rejectedUsd(figuresAtGuard(90).ilgExampleRejected), 50);
  });

  it("say a Guard of 100% never rejects, since no position is below $0", () => {
    const clause = figuresAtGuard(100).ilgExampleRejected;
    assert.doesNotMatch(clause, /\$-|rejected and left alone/);
    assert.match(clause, /never rejects/);
  });

  it("keep the guard's retry ladder at or under its ceiling", () => {
    // Three hours doubling under a 20-hour ceiling: a fourth rung, a day, is past it.
    assert.equal(F.ilgRetryLadder, "3h, 6h, 12h");
    assert.equal(F.ilgRetryCeiling, "20 hours");
  });

  it("are plain text, safe to set as a page element's text", () => {
    for (const [name, value] of Object.entries(F))
      assert.doesNotMatch(value, /[<>&]/, name);
  });
});

describe("filling the copy", () => {
  it("replaces figure tokens and leaves other tokens for their owner", () => {
    assert.equal(
      fillFigureTokens("{{figure:ilgDefaultPct}}% of {{token0}}", F),
      `${F.ilgDefaultPct}% of {{token0}}`,
    );
  });

  it("can fill a token inside the span the served manual refills", () => {
    assert.equal(
      spanFigureTokens("{{figure:ilgDefaultPct}}% of {{token0}}", F),
      `<span data-figure="ilgDefaultPct">${F.ilgDefaultPct}</span>% of {{token0}}`,
    );
    const entry = fillEntryFigures(
      {
        title: "t",
        sections: [{ heading: "h", body: "{{figure:ilgDefaultPct}}%" }],
      },
      F,
      spanFigureTokens,
    );
    assert.equal(
      entry.sections[0].body,
      `<span data-figure="ilgDefaultPct">${F.ilgDefaultPct}</span>%`,
    );
    assert.throws(() => spanFigureTokens("{{figure:noSuchFigure}}", F));
  });

  it("fills a whole entry, headings included, and leaves the entry as it was", () => {
    const entry = {
      title: "T",
      sections: [{ heading: "{{figure:ilgRetryFirst}}", body: "b" }],
    };
    const filled = fillEntryFigures(entry, F);
    assert.equal(filled.sections[0].heading, F.ilgRetryFirst);
    assert.equal(entry.sections[0].heading, "{{figure:ilgRetryFirst}}");
  });

  it("rewrites a figure span's text, the same on every run", () => {
    const once = fillFigureSpans(
      '<span data-figure="ilgDefaultPct">stale</span>',
      F,
    );
    assert.equal(
      once,
      `<span data-figure="ilgDefaultPct">${F.ilgDefaultPct}</span>`,
    );
    assert.equal(fillFigureSpans(once, F), once);
  });

  it("refuses a token or a span naming no figure", () => {
    assert.throws(
      () => fillFigureTokens("{{figure:nope}}", F),
      /does not exist: nope/,
    );
    assert.throws(
      () => fillFigureSpans('<span data-figure="nope"></span>', F),
      /does not exist: nope/,
    );
  });
});

describe("the module", () => {
  it("imports nothing, so the dashboard bundle can take it in", () => {
    /*-
     *  The dashboard imports it for the dialogs; a `require` of anything
     *  Node-only would break that build, not a test.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "help-figures.js"),
      "utf8",
    );
    assert.deepEqual(src.match(/\brequire\s*\(/g) || [], []);
    assert.deepEqual(src.match(/^\s*import\s/gm) || [], []);
  });
});
