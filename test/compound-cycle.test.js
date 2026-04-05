/**
 * @file test/compound-cycle.test.js
 * @description Tests for compound check logic in bot-cycle.js pollCycle.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _poll } = require("./_bot-loop-helpers");

describe("pollCycle compound gates", () => {
  it("does not trigger compound when autoCompound disabled and no force", async () => {
    const { r } = await _poll(500, {
      botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        autoCompoundEnabled: false,
        forceCompound: false,
      },
      getConfig: (k) =>
        ({
          autoCompoundEnabled: false,
          autoCompoundThresholdUsd: 5,
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
        })[k],
    });
    assert.equal(r.rebalanced, false);
    assert.equal(r.inRange, true);
  });

  it("does not trigger compound when fees below threshold", async () => {
    const { r } = await _poll(500, {
      botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        autoCompoundEnabled: true,
      },
      getConfig: (k) =>
        ({
          autoCompoundEnabled: true,
          autoCompoundThresholdUsd: 100,
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
        })[k],
      setupDeps: (deps) => {
        deps._lastUnclaimedFeesUsd = 0.5;
      },
    });
    assert.equal(r.rebalanced, false);
    assert.equal(r.inRange, true);
  });

  it("does not trigger compound when throttle interval not elapsed", async () => {
    const { r } = await _poll(500, {
      botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
      },
      getConfig: (k) =>
        ({
          autoCompoundEnabled: true,
          autoCompoundThresholdUsd: 1,
          lastCompoundAt: new Date().toISOString(),
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
        })[k],
      setupDeps: (deps) => {
        deps._lastUnclaimedFeesUsd = 10;
      },
    });
    assert.equal(r.rebalanced, false);
    assert.equal(r.inRange, true);
  });

  it("returns inRange when position is in range (no compound, no rebalance)", async () => {
    const { r } = await _poll(500, {
      botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
      },
    });
    assert.equal(r.rebalanced, false);
    assert.equal(r.inRange, true);
  });
});

describe("atomic config write", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  it("saveConfig writes valid JSON via temp+rename", () => {
    const { saveConfig, loadConfig } = require("../src/bot-config-v2");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-test-"));
    const cfg = {
      global: { triggerType: "oor" },
      positions: { k1: { status: "running", totalCompoundedUsd: 10 } },
    };
    saveConfig(cfg, dir);
    const loaded = loadConfig(dir);
    assert.equal(loaded.positions.k1.status, "running");
    assert.equal(loaded.positions.k1.totalCompoundedUsd, 10);
    assert.equal(loaded.global.triggerType, "oor");
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
    fs.rmSync(dir, { recursive: true });
  });

  it("loadConfig returns empty on missing file", () => {
    const { loadConfig } = require("../src/bot-config-v2");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-test-"));
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.global, {});
    assert.deepEqual(loaded.positions, {});
    fs.rmSync(dir, { recursive: true });
  });

  it("loadConfig returns empty on corrupt JSON", () => {
    const { loadConfig } = require("../src/bot-config-v2");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corrupt-test-"));
    fs.writeFileSync(path.join(dir, ".bot-config.json"), "not json", "utf8");
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.global, {});
    assert.deepEqual(loaded.positions, {});
    fs.rmSync(dir, { recursive: true });
  });

  it("strips legacy version and managedPositions fields", () => {
    const { saveConfig, loadConfig } = require("../src/bot-config-v2");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-test-"));
    const cfg = {
      version: 1,
      managedPositions: ["old"],
      global: {},
      positions: { k: { status: "running" } },
    };
    saveConfig(cfg, dir);
    const loaded = loadConfig(dir);
    assert.equal(loaded.positions.k.status, "running");
    assert.equal(cfg.version, undefined);
    assert.equal(cfg.managedPositions, undefined);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("pnl-tracker residuals in dailyPnl", () => {
  it("dailyPnl includes residual field", () => {
    const { createPnlTracker } = require("../src/pnl-tracker");
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.9,
      upperPrice: 1.1,
    });
    const snap = tracker.snapshot(1.0);
    assert.ok(Array.isArray(snap.dailyPnl));
    if (snap.dailyPnl.length > 0) {
      assert.equal(typeof snap.dailyPnl[0].residual, "number");
    }
  });

  it("missingPrice flag propagates to dailyPnl", () => {
    const { createPnlTracker } = require("../src/pnl-tracker");
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.restore({
      closedEpochs: [
        {
          id: 1,
          entryValue: 100,
          exitValue: 90,
          fees: 1,
          gas: 0,
          il: 0,
          feePnl: 1,
          priceChangePnl: -10,
          epochPnl: -9,
          openTime: Date.now() - 86400000,
          closeTime: Date.now() - 43200000,
          missingPrice: true,
          status: "closed",
        },
      ],
      liveEpoch: null,
    });
    const snap = tracker.snapshot(1.0);
    const day = snap.dailyPnl.find((d) => d.missingPrice);
    assert.ok(day, "Expected a day with missingPrice=true");
  });
});

describe("compound config defaults", () => {
  it("COMPOUND_MIN_FEE_USD defaults to 1", () => {
    const config = require("../src/config");
    assert.equal(config.COMPOUND_MIN_FEE_USD, 1);
  });

  it("COMPOUND_DEFAULT_THRESHOLD_USD defaults to 5", () => {
    const config = require("../src/config");
    assert.equal(config.COMPOUND_DEFAULT_THRESHOLD_USD, 5);
  });

  it("threshold must be >= min fee", () => {
    const config = require("../src/config");
    assert.ok(
      config.COMPOUND_DEFAULT_THRESHOLD_USD >= config.COMPOUND_MIN_FEE_USD,
    );
  });
});

describe("compound P&L integration", () => {
  it("overridePnlWithRealValues sets totalCompoundedUsd on snapshot", () => {
    const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
    const snap = {
      closedEpochs: [],
      liveEpoch: { entryValue: 200, fees: 10 },
      initialDeposit: 200,
      totalGas: 0,
    };
    const deps = {
      _botState: { totalCompoundedUsd: 5 },
      _collectedFeesUsd: 0,
    };
    overridePnlWithRealValues(
      snap,
      deps,
      { liquidity: "1000000", tickLower: 0, tickUpper: 1000 },
      { tick: 500, decimals0: 8, decimals1: 8 },
      0.001,
      0.001,
      10,
      0,
    );
    assert.equal(snap.totalCompoundedUsd, 5);
  });

  it("totalCompoundedUsd is set on snapshot", () => {
    const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
    const snap = {
      closedEpochs: [],
      liveEpoch: { entryValue: 100, fees: 5 },
      initialDeposit: 100,
      totalGas: 0,
    };
    overridePnlWithRealValues(
      snap,
      { _botState: { totalCompoundedUsd: 7 }, _collectedFeesUsd: 10 },
      { liquidity: "100000000", tickLower: 0, tickUpper: 1000 },
      { tick: 500, decimals0: 8, decimals1: 8 },
      0.001,
      0.001,
      5,
      0,
    );
    assert.equal(snap.totalCompoundedUsd, 7);
    assert.ok(typeof snap.netReturn === "number");
    assert.ok(typeof snap.cumulativePnl === "number");
  });

  it("createPerPositionBotState restores compound state", () => {
    const { createPerPositionBotState } = require("../src/server-positions");
    const saved = {
      totalCompoundedUsd: 25,
      compoundHistory: [{ trigger: "auto" }, { trigger: "manual" }],
      lastCompoundAt: "2026-04-04T10:00:00Z",
      hodlBaseline: { entryValue: 100 },
    };
    const state = createPerPositionBotState({}, saved);
    assert.equal(state.totalCompoundedUsd, 25);
    assert.equal(state.compoundHistory.length, 2);
    assert.equal(state.lastCompoundAt, "2026-04-04T10:00:00Z");
    assert.deepEqual(state.hodlBaseline, { entryValue: 100 });
  });
});
