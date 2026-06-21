/**
 * @file test/bot-config-defaults.test.js
 * @description Unit tests for src/bot-config-defaults.js and the
 * GET /api/bot-config-defaults route handler.
 *
 * Tests write to the gitignored
 * `app-config/user-configurable/bot-config-defaults.json` (operator
 * override) rather than the tracked shipped file under
 * `app-defaults-for-user-configurable/` — the loader deep-merges the
 * user file on top of the shipped defaults, so this exercises the
 * exact same path real operators use.  The shipped file is the
 * known-good baseline that `loadShippedDefaults()` reads once at
 * module init for the per-key fallback when an operator's override
 * contains an out-of-range value.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _SHIPPED_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "bot-config-defaults.json",
);

const _USER_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "user-configurable",
  "bot-config-defaults.json",
);

/*- The shipped JSON is the source of truth for default values; the
 *  tests read it (NOT a hardcoded copy) so this file never drifts
 *  when an operator updates the shipped defaults. */
const _SHIPPED = JSON.parse(fs.readFileSync(_SHIPPED_FILE, "utf8"));

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/bot-config-defaults")];
  delete require.cache[require.resolve("../src/load-merged-defaults")];
}

function _writeUser(obj) {
  fs.writeFileSync(_USER_FILE, JSON.stringify(obj));
}

function _clearUser() {
  /*- TOCTOU-safe: a parallel test (24-way concurrency per
   *  package.json) could unlink between exists and unlink.  Treat
   *  ENOENT as success since the post-condition (file absent) holds. */
  try {
    fs.unlinkSync(_USER_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

beforeEach(() => {
  _clearUser();
  _clearModuleCache();
});

afterEach(() => {
  _clearUser();
  _clearModuleCache();
});

describe("bot-config-defaults.readBotConfigDefaults", () => {
  it("returns approvalMultiple from the shipped JSON when no override exists", () => {
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("returns operator-edited approvalMultiple from the user override", () => {
    _writeUser({ approvalMultiple: 50 });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 50);
  });

  it("falls back to shipped default when user override is malformed JSON", () => {
    fs.writeFileSync(_USER_FILE, "{ not valid json");
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("ignores non-numeric override values (falls back to shipped)", () => {
    _writeUser({ approvalMultiple: "forty" });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("floors fractional approvalMultiple overrides", () => {
    _writeUser({ approvalMultiple: 25.8 });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 25);
  });

  it("rejects approvalMultiple < 1 in override (falls back to shipped)", () => {
    for (const bad of [0, -5]) {
      _writeUser({ approvalMultiple: bad });
      _clearModuleCache();
      const { readBotConfigDefaults } = require("../src/bot-config-defaults");
      const out = readBotConfigDefaults();
      assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
    }
  });

  it("rejects approvalMultiple above the 1_000_000 cap (falls back to shipped)", () => {
    _writeUser({ approvalMultiple: 2_000_000 });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("ignores _comment / _*-prefixed keys in the override (just doc fields)", () => {
    _writeUser({ _comment: "doc", approvalMultiple: 30 });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 30);
    assert.equal(out._comment, undefined);
  });

  it("returns all shipped user-setting defaults when no override exists", () => {
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.rebalanceOutOfRangeThresholdPercent,
      _SHIPPED.rebalanceOutOfRangeThresholdPercent,
    );
    assert.equal(out.rebalanceTimeoutMin, _SHIPPED.rebalanceTimeoutMin);
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.minRebalanceIntervalMin, _SHIPPED.minRebalanceIntervalMin);
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });

  it("returns operator-edited values when within range", () => {
    _writeUser({
      rebalanceOutOfRangeThresholdPercent: 7,
      rebalanceTimeoutMin: 0,
      slippagePct: 1.2,
      checkIntervalSec: 120,
      minRebalanceIntervalMin: 30,
      maxRebalancesPerDay: 50,
      offsetToken0Pct: 60,
    });
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

  it("rejects out-of-range overrides and falls back per-key to shipped", () => {
    _writeUser({
      rebalanceOutOfRangeThresholdPercent: 0, // below min
      rebalanceTimeoutMin: -10, // negative
      slippagePct: 99, // above max
      checkIntervalSec: 1, // below min
      minRebalanceIntervalMin: 9999, // above max
      maxRebalancesPerDay: 0, // below min
      offsetToken0Pct: 200, // above max
    });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.rebalanceOutOfRangeThresholdPercent,
      _SHIPPED.rebalanceOutOfRangeThresholdPercent,
    );
    assert.equal(out.rebalanceTimeoutMin, _SHIPPED.rebalanceTimeoutMin);
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.minRebalanceIntervalMin, _SHIPPED.minRebalanceIntervalMin);
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });

  it("returns priceCacheTtlMs and dustUnitPriceCacheMultiplier shipped defaults", () => {
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.priceCacheTtlMs, _SHIPPED.priceCacheTtlMs);
    assert.equal(
      out.dustUnitPriceCacheMultiplier,
      _SHIPPED.dustUnitPriceCacheMultiplier,
    );
  });

  it("clamps priceCacheTtlMs and dustUnitPriceCacheMultiplier override to safe bounds", () => {
    _writeUser({
      priceCacheTtlMs: 0, // below 1_000 ms floor
      dustUnitPriceCacheMultiplier: 0, // below 1 floor
    });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.priceCacheTtlMs,
      _SHIPPED.priceCacheTtlMs,
      "falls back to shipped",
    );
    assert.equal(
      out.dustUnitPriceCacheMultiplier,
      _SHIPPED.dustUnitPriceCacheMultiplier,
      "falls back to shipped",
    );
  });

  it("accepts in-range priceCacheTtlMs / dustUnitPriceCacheMultiplier overrides", () => {
    _writeUser({
      priceCacheTtlMs: 60_000,
      dustUnitPriceCacheMultiplier: 60,
    });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.priceCacheTtlMs, 60_000);
    assert.equal(out.dustUnitPriceCacheMultiplier, 60);
  });

  it("ignores non-numeric override values and keeps shipped defaults", () => {
    _writeUser({
      slippagePct: "half",
      checkIntervalSec: null,
      offsetToken0Pct: true,
    });
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });
});

describe("bot-config-defaults.handleBotConfigDefaults", () => {
  it("returns 200 with the merged defaults (user override applied)", () => {
    _writeUser({ approvalMultiple: 75 });
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

  it("returns 200 with shipped defaults when no user override exists", () => {
    const { handleBotConfigDefaults } = require("../src/bot-config-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleBotConfigDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.approvalMultiple, _SHIPPED.approvalMultiple);
  });
});
