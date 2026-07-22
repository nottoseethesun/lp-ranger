"use strict";

/**
 * @file test/dashboard-routing-labels.test.js
 * @description Pins the client-side swap-routing label in
 *   `public/dashboard-routing-labels.js`.  The constant MUST match the
 *   server-side `AGGREGATOR_LABEL` exported from
 *   `src/rebalancer-aggregator.js` and the HTML pre-render default in
 *   `public/index.html`.  A silent drift here would show a stale
 *   "Routing through:" badge on the Mission Control panel that no
 *   longer matches what the server stamps onto rebalance results.
 *
 *   Uses jsdom + direct import of the real browser module.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let serverMod;

before(async () => {
  mod = await import("../public/dashboard-routing-labels.js");
  serverMod = require("../src/rebalancer-aggregator.js");
});

describe("dashboard-routing-labels — AGGREGATOR_LABEL", () => {
  it("exports the current 9mm Aggregator label", () => {
    assert.strictEqual(mod.AGGREGATOR_LABEL, "9mm Aggregator");
  });

  it("matches the server-side AGGREGATOR_LABEL — drift here breaks the Routing badge", () => {
    // Guards against one side moving without the other.
    assert.strictEqual(
      mod.AGGREGATOR_LABEL,
      serverMod.AGGREGATOR_LABEL,
      "client dashboard-routing-labels.AGGREGATOR_LABEL must equal server rebalancer-aggregator.AGGREGATOR_LABEL",
    );
  });
});
