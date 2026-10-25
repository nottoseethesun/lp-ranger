"use strict";

/**
 * @file test/resolved-settings.test.js
 * @description The help quotes, and Bot Settings shows, the values this
 *   install runs on: the shipped file, the operator's override on top,
 *   and `.env` on top of both for the settings it can set.
 *
 *   The user, 2026-10-17: "All help text should just quote whatever is the
 *   final resolved json value, which means, of course, it should include
 *   overrides done by the user", and "include .env too". Each layer is set
 *   here before anything under `src/lib/` loads: an override file of the
 *   test's own, and an environment variable, which dotenv leaves alone
 *   once it is set, so the operator's own `.env` cannot reach these cases.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "resolved-settings-"));
fs.writeFileSync(
  path.join(_USER_DIR, "bot-config-defaults.json"),
  JSON.stringify({ gasFeePct: 2, maxRebalancesPerDay: 9 }),
);
/*-
 *  The dashboard settings the server sends are resolved the same way, and
 *  the help quotes two of them: the NEAR LIMIT threshold and a slippage
 *  confirmation tier.
 */
fs.writeFileSync(
  path.join(_USER_DIR, "ui-defaults_non-layout_for-server-up-scenario.json"),
  JSON.stringify({ throttleNearLimitPct: 60, slippageConfirmAbovePct: 3 }),
);
/*-
 *  The help names the chain and its aggregator as chains.json does, the
 *  operator's copy on top: renamed here, so a name written into the
 *  code would not match.
 */
fs.writeFileSync(
  path.join(_USER_DIR, "chains.json"),
  JSON.stringify({
    pulsechain: {
      displayName: "Renamed Chain",
      aggregator: { name: "Renamed Aggregator" },
    },
  }),
);
// The compound minimum the help quotes comes from app-runtime.json, the copy on top.
fs.writeFileSync(
  path.join(_USER_DIR, "app-runtime.json"),
  JSON.stringify({ compound: { minFeeUsd: 3 } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
/*-
 *  `.env` sets the daily cap too, and wins: the override above says 9,
 *  this says 8. It sets the speed-up and cancel waits the help quotes as
 *  well, which no file here does.
 */
process.env.MAX_REBALANCES_PER_DAY = "8";
process.env.TX_SPEEDUP_SEC = "90";
process.env.TX_CANCEL_SEC = "7200";
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const config = require("../src/lib/config");
const {
  resolvedBotDefaults,
  resolvedHelpFigures,
  handleBotConfigDefaults,
  handleHelpFigures,
} = require("../src/server/resolved-settings");
const {
  userConfigurableRoutes,
} = require("../src/server/user-configurable-routes");
const mergedLoader = require("../src/lib/load-merged-defaults");
const defaultsReader = require("../src/lib/bot-config-defaults");

const SHIPPED = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");

/** Call a route handler and return what it answered. */
function answer(handler) {
  let status = null;
  let body = null;
  handler({}, {}, (_res, s, b) => {
    status = s;
    body = b;
  });
  return { status, body };
}

describe("resolvedBotDefaults", () => {
  it("takes the operator's override over the shipped value", () => {
    assert.equal(resolvedBotDefaults().gasFeePct, 2);
    assert.notEqual(SHIPPED.gasFeePct, 2);
  });

  it("takes .env over both, for a setting .env can set", () => {
    assert.equal(config.MAX_REBALANCES_PER_DAY, 8);
    assert.equal(resolvedBotDefaults().maxRebalancesPerDay, 8);
  });

  it("keeps the shipped value where neither layer sets one", () => {
    assert.equal(
      resolvedBotDefaults().historyLookbackYears,
      SHIPPED.historyLookbackYears,
    );
  });

  it("is what GET /api/bot-config-defaults answers", () => {
    const { status, body } = answer(handleBotConfigDefaults);
    assert.equal(status, 200);
    assert.deepEqual(body, resolvedBotDefaults());
  });
});

describe("resolvedHelpFigures", () => {
  it("quotes the resolved values", () => {
    const f = resolvedHelpFigures();
    assert.equal(f.gasFeeDefaultPct, "2");
    assert.equal(f.dailyCapDefault, "8");
    assert.equal(f.txSpeedup, "90 seconds");
    assert.equal(f.txCancelSec, "7200");
    assert.equal(f.compoundMinFeeUsd, "3");
  });

  it("quotes the dashboard settings the server sends, an override included", () => {
    const f = resolvedHelpFigures();
    assert.equal(f.nearLimitPct, "60");
    assert.equal(f.slippageConfirmAbovePct, "3");
  });

  it("names the chain the install runs on and its aggregator, an override included", () => {
    const f = resolvedHelpFigures();
    assert.equal(config.CHAIN_NAME, "pulsechain", "the shipped chain");
    assert.equal(f.chainKey, "pulsechain");
    assert.equal(f.chainName, "Renamed Chain");
    assert.equal(f.aggregatorName, "Renamed Aggregator");
    assert.equal(f.aggregatorInUse, "Renamed Aggregator");
  });

  it("is what GET /api/help-figures answers, with the defaults behind it", () => {
    const { status, body } = answer(handleHelpFigures);
    assert.equal(status, 200);
    assert.deepEqual(body.figures, resolvedHelpFigures());
    assert.deepEqual(body.botDefaults, resolvedBotDefaults());
  });

  it("is routed", () => {
    const routes = userConfigurableRoutes((res, s, b) => {
      res.status = s;
      res.body = b;
    });
    const res = {};
    routes["GET /api/help-figures"]({}, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.figures.dailyCapDefault, "8");
  });
});

/*-
 *  Last, because it rewrites the override file the cases above read.
 */
describe("GET /api/bot-config-defaults after a bad edit while running", () => {
  it("still answers 200, with the shipped value standing for the bad one", () => {
    /*-
     *  Startup refuses an override out of range; an edit made after it is
     *  read by the lenient reader, which keeps the shipped value rather
     *  than throwing, so the route stays off a 500.
     */
    fs.writeFileSync(
      path.join(_USER_DIR, "bot-config-defaults.json"),
      JSON.stringify({ gasFeePct: 99 }),
    );
    mergedLoader._resetMemoForTests();
    defaultsReader._resetMemoForTests();
    const { status, body } = answer(handleBotConfigDefaults);
    assert.equal(status, 200);
    assert.equal(body.gasFeePct, SHIPPED.gasFeePct);
  });
});
