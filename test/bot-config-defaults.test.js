/**
 * @file test/bot-config-defaults.test.js
 * @description Unit tests for src/bot-config-defaults.js and the
 * GET /api/bot-config-defaults route handler. Covers the happy path,
 * missing-file fallback, malformed-JSON fallback, clamping of the
 * approvalMultiple integer, and the always-200 route contract.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "bot-config-defaults.json",
);

let _originalContent = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/bot-config-defaults")];
}

beforeEach(() => {
  if (fs.existsSync(_FILE)) _originalContent = fs.readFileSync(_FILE, "utf8");
  _clearModuleCache();
});

afterEach(() => {
  if (_originalContent !== null) fs.writeFileSync(_FILE, _originalContent);
  _originalContent = null;
  _clearModuleCache();
});

describe("bot-config-defaults.readBotConfigDefaults", () => {
  it("returns approvalMultiple from the on-disk JSON", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 50 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 50);
  });

  it("falls back to built-in default when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("falls back to built-in default when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("ignores non-numeric approvalMultiple values", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: "forty" }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("floors fractional approvalMultiple values", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 25.8 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 25);
  });

  it("rejects approvalMultiple < 1 (falls back to built-in)", () => {
    for (const bad of [0, -5]) {
      fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: bad }));
      _clearModuleCache();
      const { readBotConfigDefaults } = require("../src/bot-config-defaults");
      const out = readBotConfigDefaults();
      assert.equal(out.approvalMultiple, 20);
    }
  });

  it("rejects approvalMultiple above the 1_000_000 cap", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 2_000_000 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("ignores the _comment key (just a doc field)", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({ _comment: "doc", approvalMultiple: 30 }),
    );
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 30);
    assert.equal(out._comment, undefined);
  });

  it("returns all built-in user-setting defaults when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.rebalanceOutOfRangeThresholdPercent, 5);
    assert.equal(out.rebalanceTimeoutMin, 180);
    assert.equal(out.slippagePct, 0.5);
    assert.equal(out.checkIntervalSec, 60);
    assert.equal(out.minRebalanceIntervalMin, 10);
    assert.equal(out.maxRebalancesPerDay, 20);
    assert.equal(out.offsetToken0Pct, 50);
  });

  it("returns operator-edited values when within range", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        rebalanceOutOfRangeThresholdPercent: 7,
        rebalanceTimeoutMin: 0,
        slippagePct: 1.2,
        checkIntervalSec: 120,
        minRebalanceIntervalMin: 30,
        maxRebalancesPerDay: 50,
        offsetToken0Pct: 60,
      }),
    );
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.rebalanceOutOfRangeThresholdPercent, 7);
    assert.equal(out.rebalanceTimeoutMin, 0);
    assert.equal(out.slippagePct, 1.2);
    assert.equal(out.checkIntervalSec, 120);
    assert.equal(out.minRebalanceIntervalMin, 30);
    assert.equal(out.maxRebalancesPerDay, 50);
    assert.equal(out.offsetToken0Pct, 60);
  });

  it("rejects out-of-range values and falls back per-key", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        rebalanceOutOfRangeThresholdPercent: 0, // below min
        rebalanceTimeoutMin: -10, // negative
        slippagePct: 99, // above max
        checkIntervalSec: 1, // below min
        minRebalanceIntervalMin: 9999, // above max
        maxRebalancesPerDay: 0, // below min
        offsetToken0Pct: 200, // above max
      }),
    );
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.rebalanceOutOfRangeThresholdPercent, 5);
    assert.equal(out.rebalanceTimeoutMin, 180);
    assert.equal(out.slippagePct, 0.5);
    assert.equal(out.checkIntervalSec, 60);
    assert.equal(out.minRebalanceIntervalMin, 10);
    assert.equal(out.maxRebalancesPerDay, 20);
    assert.equal(out.offsetToken0Pct, 50);
  });

  it("ignores non-numeric values and keeps built-in defaults", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        slippagePct: "half",
        checkIntervalSec: null,
        offsetToken0Pct: true,
      }),
    );
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.slippagePct, 0.5);
    assert.equal(out.checkIntervalSec, 60);
    assert.equal(out.offsetToken0Pct, 50);
  });
});

describe("bot-config-defaults.handleBotConfigDefaults", () => {
  it("returns 200 with the current defaults", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 75 }));
    const { handleBotConfigDefaults } = require("../src/bot-config-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleBotConfigDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.approvalMultiple, 75);
  });

  it("returns 200 even when the file is missing", () => {
    fs.unlinkSync(_FILE);
    const { handleBotConfigDefaults } = require("../src/bot-config-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleBotConfigDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.approvalMultiple, 20);
  });
});
