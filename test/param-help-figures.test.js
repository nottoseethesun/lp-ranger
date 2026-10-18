"use strict";

/**
 * @file test/param-help-figures.test.js
 * @description The help dialogs state the figures the app runs on.
 *
 *   A dialog that quotes a range, a default or a timing the app does not
 *   use misleads the operator: one recommending up to 20 rebalances a
 *   day, say, while the server refuses anything above 12. So every such
 *   figure comes from the file that sets it: setting-bounds.json for
 *   ranges, bot-config-defaults.json for defaults and the doubling rule,
 *   ui-defaults_non-layout_for-server-up-scenario.json for the slippage
 *   confirmation tiers and
 *   app-runtime.json for the compound minimum and the transaction
 *   timings, with anything worked out from them taken from
 *   src/help-figures.js. These cases read the same files and check the
 *   copy says what they say.
 *
 *   The low-volume advice concerns two settings at once, so it is written
 *   once, in the Impermanent Loss Guard's shared entry, and shown in both
 *   dialogs.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const BOT = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
const UI = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-up-scenario.json");
const RUNTIME = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");
const SHARED = require("../public/shared-help-content.json");
const { count } = require("../src/help-figures");
const { shippedFigures } = require("../scripts/build-manual-content");

/*-
 *  The figures the dashboard would be sent by an install running on the
 *  shipped settings, which is what every expectation below is written
 *  from.
 */
const HELP_FIGURES = shippedFigures();
let PARAM_HELP;

before(async () => {
  const { buildParamHelp } = await import("../public/param-help-content.js");
  PARAM_HELP = buildParamHelp(HELP_FIGURES);
});

/** The low-volume section as one dialog shows it. */
const lowVolumeIn = (key) =>
  PARAM_HELP[key].sections.find((s) => s.id === "lowVolume");

/** Every section body of one dialog, joined. */
const text = (key) => PARAM_HELP[key].sections.map((s) => s.body).join("\n");

describe("Max Rebalances Per Day help", () => {
  it("states the maximum the server accepts, and no other", () => {
    const body = text("inMaxReb");
    const { min, max } = BOUNDS.maxRebalancesPerDay;
    assert.ok(body.includes(`<strong>${max}</strong> (maximum)`), body);
    assert.ok(body.includes(`<strong>${min}</strong> (minimum)`), body);
    assert.ok(
      body.includes(`<strong>${BOT.maxRebalancesPerDay}</strong>, the default`),
    );
    assert.doesNotMatch(body, /200|20\+|5&ndash;20/);
  });

  it("carries the low-volume advice", () => {
    const low = SHARED.inIlGuard.sections.find((s) => s.id === "lowVolume");
    assert.ok(low, "the shared entry holds the advice");
    assert.equal(lowVolumeIn("inMaxReb")?.body, low.body);
    assert.match(low.body, /Impermanent Loss Guard/);
    assert.match(low.body, /<strong>5%<\/strong>/);
    assert.match(
      low.body,
      /Max Rebalances Per Day<\/strong> to <strong>1<\/strong>/,
    );
  });
});

describe("the throttle badge's NEAR LIMIT example", () => {
  it("works the shipped daily cap, with its small counts spelled out", () => {
    const near = PARAM_HELP.throttleBadge.sections.find(
      (s) => s.heading === "NEAR LIMIT",
    ).body;
    const max = BOT.maxRebalancesPerDay;
    const at = Math.ceil((max * UI.throttleNearLimitPct) / 100);
    assert.ok(near.includes(`default of ${count(max)} per day`), near);
    assert.ok(near.includes(`once ${count(at)} rebalances`), near);
    assert.ok(near.includes(`leaving ${count(max - at)} before`), near);
    assert.doesNotMatch(near, /\b[0-9] (per day|rebalances|before)\b/);
  });
});

describe("Impermanent Loss Guard help", () => {
  it("carries the same low-volume advice, which the manual renders too", () => {
    const low = SHARED.inIlGuard.sections.find((s) => s.id === "lowVolume");
    assert.equal(lowVolumeIn("inIlGuard")?.body, low.body);
  });

  it("states its default and retry timings, with no token left unfilled", () => {
    const entry = PARAM_HELP.inIlGuard;
    const all = entry.sections.map((s) => s.heading + "\n" + s.body).join();
    assert.doesNotMatch(all, /\{\{figure:/);
    assert.ok(
      all.includes(
        `<strong>${BOT.impermanentLossGuardPct}%</strong> (the default)`,
      ),
    );
    assert.ok(all.includes(HELP_FIGURES.ilgRetryFirst));
    assert.ok(all.includes(HELP_FIGURES.ilgRetryCeiling));
  });
});

describe("Min Time Between Rebalances help", () => {
  it("states the range the server accepts", () => {
    const body = text("inMinInterval");
    const { min, max } = BOUNDS.minRebalanceIntervalMin;
    assert.ok(body.includes(`${max} minutes</strong> (maximum)`), body);
    assert.ok(
      body.includes(
        `${min === 1 ? "1 minute" : min + " minutes"}</strong> (minimum)`,
      ),
    );
    assert.doesNotMatch(body, /1440 minutes/);
  });
});

describe("the doubling rule, wherever the help states it", () => {
  const { triggerCount, triggerWindowMultiple, quietWindowMultiple } =
    BOT.throttleDoubling;
  const min = BOT.minRebalanceIntervalMin;

  for (const key of [
    "inMinInterval",
    "dblWindowLabel",
    "rebalanceInterval",
    "throttleBadge",
  ]) {
    it(`${key} states the trigger and the ladder from the shipped rule`, () => {
      const body = text(key);
      assert.ok(body.includes(`${triggerWindowMultiple}&times;`), body);
      assert.ok(body.includes(count(triggerCount)), body);
      // The ladder the User Manual states too, worked out in one place.
      assert.ok(body.includes(HELP_FIGURES.doublingLadder), body);
    });
  }

  it("says doubling clears after the quiet multiple of the doubled cooldown", () => {
    const body = text("throttleBadge");
    const doubled = 2 * min;
    const quiet = quietWindowMultiple * doubled;
    assert.ok(body.includes(`doubled to ${doubled} minutes`), body);
    assert.ok(
      body.includes(`clears after ${quiet} minutes with no rebalance`),
      body,
    );
  });
});

describe("other ranges the help quotes", () => {
  it("OOR Threshold states its own minimum and maximum", () => {
    const body = text("inOorThreshold");
    const { min, max } = BOUNDS.rebalanceOutOfRangeThresholdPercent;
    assert.ok(body.includes(`<strong>${min}%</strong> (minimum)`), body);
    assert.ok(body.includes(`<strong>${max}%</strong> (maximum)`), body);
  });

  it("OOR Rebalance Time Threshold states its maximum", () => {
    const { max } = BOUNDS.rebalanceTimeoutMin;
    assert.ok(text("inOorTimeout").includes(`<strong>${max} (`));
  });

  it("per-token slippage states its range, default and confirmation tiers", () => {
    const body = text("inSlipToken0");
    const { min, max } = BOUNDS.slippagePctToken0;
    assert.ok(body.includes(`<strong>${min}% to ${max}%</strong>`), body);
    assert.ok(body.includes(`(${BOT.slippagePct}%)`), body);
    assert.ok(body.includes(`Above ${UI.slippageConfirmAbovePct}%`), body);
    assert.ok(body.includes(`At ${UI.slippageTypedConfirmFromPct}% or more`));
  });

  it("Gas Fee % states its default and range", () => {
    const body = text("gasFeePct");
    const { min, max } = BOUNDS.gasFeePct;
    assert.ok(body.includes(`Default: ${BOT.gasFeePct}%.`), body);
    assert.ok(body.includes(`Bounds: ${min}% to ${max}%.`), body);
    assert.ok(body.includes(`Values below ${min}%`), body);
    assert.ok(body.includes(`values above ${max}%`), body);
  });
});

describe("defaults and timings the help quotes", () => {
  it("Auto-Compound Threshold states the compound minimum", () => {
    const body = text("autoCompoundThreshold");
    const fee = RUNTIME.compound.minFeeUsd;
    assert.ok(body.includes(`<strong>$${fee}</strong> (minimum)`), body);
    assert.ok(body.includes(`(default $${fee})`), body);
  });

  it("Auto-Compound states the Gas Fee % default its gas gate starts at", () => {
    assert.ok(
      text("autoCompoundToggle").includes(`(${BOT.gasFeePct}% by default)`),
    );
  });

  it("Approval Multiple states its default, as the install resolves it", async () => {
    // Moved off the shipped value, so a literal in the copy cannot pass.
    const { buildParamHelp } = await import("../public/param-help-content.js");
    const moved = buildParamHelp({
      ...HELP_FIGURES,
      approvalMultipleDefault: String(BOT.approvalMultiple + 17),
    });
    const body = moved.inApprovalMultiple.sections
      .map((s) => s.body)
      .join("\n");
    assert.ok(
      body.includes(`<strong>${BOT.approvalMultiple + 17}</strong> (default)`),
      body,
    );
  });

  it("Position Offset states its default", () => {
    assert.ok(
      text("inOffsetToken0").includes(
        `the default is <strong>${BOT.offsetToken0Pct}%</strong>`,
      ),
    );
  });

  it("both slippage rows state the shipped default", () => {
    for (const key of ["inSlipToken0", "inSlipToken1"])
      assert.ok(text(key).includes(`(${BOT.slippagePct}%)`), key);
  });
});

describe("the retired single slippage setting", () => {
  it("has no help entry, since no control opens one", () => {
    assert.equal(PARAM_HELP.inSlip, undefined);
  });
});
