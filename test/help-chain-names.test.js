"use strict";

/**
 * @file test/help-chain-names.test.js
 * @description The help names the chain the app runs on, and the
 *   aggregator its swaps try first, as chains.json names them. The user,
 *   2026-10-18, asked whether the help's "PulseChain" and "Watergun
 *   Aggregator" should come from chains.json: "On the Help, yes, pull
 *   those from the json."
 *
 *   Both names reach the dialogs and the User Manual as help figures
 *   (src/lib/help-figures.js). These cases build both from figures naming a
 *   chain and an aggregator that no shipped file names, so copy that
 *   still typed either name in would not say them. A chain with no
 *   aggregator is worded apart: "the" followed by an empty name would
 *   not read.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const BOT = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const RUNTIME = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");
const UI = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-up-scenario.json");
const SHARED = require("../src/lib/shared-help-content.json");
const { helpFigures } = require("../src/lib/help-figures");
const { render } = require("../scripts/build-manual-content");

const MANUAL = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "src",
    "client",
    "web",
    "help-and-user-manual.html",
  ),
  "utf8",
);

/** The shipped figures, for a chain and aggregator of the test's own. */
function figuresFor(aggregatorName) {
  return helpFigures({
    botDefaults: BOT,
    settingBounds: BOUNDS,
    uiDefaults: UI,
    appRuntime: RUNTIME,
    txSpeedupSec: RUNTIME.tx.speedupSec,
    txCancelSec: RUNTIME.tx.deadlineSec * RUNTIME.tx.cancelToDeadlineMultiple,
    compoundMinFeeUsd: RUNTIME.compound.minFeeUsd,
    chainKey: "testchain",
    chainName: "Testchain",
    aggregatorName,
  });
}

let buildParamHelp;

before(async () => {
  ({ buildParamHelp } =
    await import("../src/client/web/param-help-content.js"));
});

/** Every section body of one dialog, joined. */
const text = (help, key) => help[key].sections.map((s) => s.body).join("\n");

describe("the help dialogs", () => {
  it("name the chain the figures name", () => {
    const help = buildParamHelp(figuresFor("Foo Aggregator"));
    const rpc = text(help, "rpcUrls");
    assert.ok(rpc.includes("your connection to the Testchain network"), rpc);
    assert.ok(rpc.includes("If you run your own Testchain node"), rpc);
    assert.ok(
      text(help, "autoCompoundThreshold").includes("for Testchain (gas"),
    );
  });

  it("name the aggregator the figures name", () => {
    const help = buildParamHelp(figuresFor("Foo Aggregator"));
    assert.ok(
      text(help, "inApprovalMultiple").includes(
        "(the V3 Router, the Foo Aggregator, or the Position Manager)",
      ),
    );
    assert.ok(
      text(help, "swapRouting").includes(
        "LP Ranger uses one aggregator, the Foo Aggregator",
      ),
    );
  });

  it("name neither PulseChain nor Watergun anywhere, when the figures name another chain", () => {
    const help = buildParamHelp(figuresFor("Foo Aggregator"));
    for (const [key, entry] of Object.entries(help)) {
      const words = [
        entry.title,
        entry.subtitle,
        ...entry.sections.flatMap((s) => [s.heading, s.body]),
      ].join("\n");
      assert.doesNotMatch(words, /PulseChain|Watergun/i, key);
    }
  });

  it("word a chain with no aggregator apart", () => {
    const help = buildParamHelp(figuresFor(""));
    assert.ok(
      text(help, "inApprovalMultiple").includes(
        "(the V3 Router or the Position Manager)",
      ),
    );
    assert.equal(
      text(help, "swapRouting"),
      "On Testchain, LP Ranger uses no aggregator: every swap goes " +
        "through the V3 Router.",
    );
  });
});

describe("the User Manual", () => {
  it("names the chain, its address segment and its aggregator through figures", () => {
    const out = render(MANUAL, SHARED, figuresFor("Foo Aggregator"));
    const chain = '<span data-figure="chainName">Testchain</span>';
    assert.ok(out.includes(`your own ${chain} Archive RPC node`));
    assert.ok(out.includes(`access to a ${chain} Archive node`));
    assert.ok(
      out.includes(
        "DEX aggregator (" +
          '<span data-figure="aggregatorInUse">Foo Aggregator</span>)',
      ),
    );
    assert.ok(
      out.includes(
        '<code>/<span data-figure="chainKey">testchain</span>/&lt;wallet&gt;',
      ),
    );
  });

  it("says a chain with no aggregator has none", () => {
    const out = render(MANUAL, SHARED, figuresFor(""));
    assert.ok(
      out.includes(
        'DEX aggregator (<span data-figure="aggregatorInUse">none</span>)',
      ),
    );
  });
});
