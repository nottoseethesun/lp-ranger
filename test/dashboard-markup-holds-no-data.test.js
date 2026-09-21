"use strict";

/**
 * @file test/dashboard-markup-holds-no-data.test.js
 * @description Guards the rule that `public/index.html` carries no data
 *   — no default values, no bounds — only presentation.
 *
 *   This project has been bitten by both halves of it.
 *
 *   A **default** in the markup: `#inMaxReb` shipped with `value="20"`,
 *   which read as the saved Max Rebalances / Day until someone removed
 *   it, whereupon the client read `0` and the throttle badge painted a
 *   false CAPPED. The markup had been silently authoritative for a
 *   value that belongs to the server, and nothing noticed until the
 *   duplication was taken out.
 *
 *   A **bound** in the markup: seventeen inputs declared their own
 *   `min`/`max`, and three had drifted from what the server accepts —
 *   Max Rebalances / Day said 200 against the server's 12. A bound on
 *   an element binds one frontend anyway, so it cannot be the rule; it
 *   can only be a second, quieter answer to the same question.
 *
 *   The two checks below differ in reach on purpose. A default in the
 *   markup is always wrong, so that one sweeps every number input. A
 *   bound is wrong only where the server has taken over the question,
 *   so that one is driven by the keys `src/config-bounds.js` actually
 *   declares — the handful of inputs with no server-side rule keep
 *   theirs, since stripping those would leave them checked nowhere.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const { indexHtmlDocument } = require("./helpers/index-html");
const { BOUNDS } = require("../src/config-bounds");

let doc;

before(() => {
  doc = indexHtmlDocument();
});

/*- Every setting `src/config-bounds.js` declares a numeric range for,
 *  and the input an operator types it into — or `null` where there is
 *  no input. The third test below fails if this list falls behind the
 *  checker. */
const INPUT_BY_KEY = {
  checkIntervalSec: "inInterval",
  rebalanceTimeoutMin: "inOorTimeout",
  minRebalanceIntervalMin: "inMinInterval",
  maxRebalancesPerDay: "inMaxReb",
  impermanentLossGuardPct: "inIlGuard",
  rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
  rebalanceRangeWidthPct: "inRangeWidth",
  offsetToken0Pct: "inOffsetToken0",
  slippagePctToken0: "inSlipToken0",
  slippagePctToken1: "inSlipToken1",
  autoCompoundThresholdUsd: "autoCompoundThreshold",
  approvalMultiple: "inApprovalMultiple",
  gasFeePct: "inGasFeePct",
  initialDepositUsd: "initialDepositInput",
  priceOverride0: "priceOverrideInput0",
  priceOverride1: "priceOverrideInput1",
  decimalsOverride0: "pdDecimals0",
  decimalsOverride1: "pdDecimals1",
};

describe("public/index.html holds no data", () => {
  it("gives no number input a hard-coded value", () => {
    /*- Every shipped default lives in the JSON under app-config/ and
     *  reaches the input through `/api/bot-config-defaults` or
     *  `/api/status`. An input may start empty; it may not start
     *  wrong. */
    const offenders = [...doc.querySelectorAll('input[type="number"]')]
      .filter((el) => el.hasAttribute("value"))
      .map((el) => `#${el.id} value="${el.getAttribute("value")}"`);
    assert.deepEqual(
      offenders,
      [],
      "a default value is hard-coded in the markup: " + offenders.join(", "),
    );
  });

  it("gives no server-bounded input its own min or max", () => {
    const offenders = [];
    for (const [key, id] of Object.entries(INPUT_BY_KEY)) {
      if (id === null) continue;
      const el = doc.getElementById(id);
      assert.ok(el, `${id} is not in the markup — INPUT_BY_KEY is stale`);
      for (const attr of ["min", "max"])
        if (el.hasAttribute(attr))
          offenders.push(`#${id} ${attr}="${el.getAttribute(attr)}" (${key})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "a bound the server owns is restated in the markup: " +
        offenders.join(", "),
    );
  });

  it("covers every key the checker declares a numeric range for", () => {
    /*- `INPUT_BY_KEY` is hand-written, so this is what stops it going
     *  stale: a new bounded setting fails here until it is listed, with
     *  its input or with `null`. */
    const missing = Object.keys(BOUNDS).filter((k) => !(k in INPUT_BY_KEY));
    assert.deepEqual(
      missing,
      [],
      "config-bounds declares a range for a setting this test does not " +
        "check the markup for: " +
        missing.join(", "),
    );
  });
});
