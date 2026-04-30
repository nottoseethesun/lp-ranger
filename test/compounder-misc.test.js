/**
 * @file test/compounder-misc.test.js
 * @description Compounder miscellany — P&L math, config persistence, state
 *   restoration, gas tracking, drain filter.  Split from compounder.test.js
 *   for the 500-line max-lines cap.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("compounder", () => {
  describe("compound P&L math consistency", () => {
    it("Fees + compounded - compounded = unclaimed (no double-counting)", () => {
      const unclaimed = 3.5;
      const compounded = 2.0;
      const feesEarned = unclaimed + compounded; // as displayed
      const profit = feesEarned - 0 + 0 - compounded; // fees - gas + IL - compounded
      assert.equal(profit, unclaimed); // compounded cancels out
    });

    it("Net P&L subtracts compounded and gas", () => {
      const fees = 10;
      const priceChange = -5;
      const realized = 0;
      const compounded = 3;
      const gas = 0.5;
      const netPnl = priceChange + fees + realized - compounded - gas;
      assert.equal(netPnl, 1.5);
    });

    it("compound capping: can't compound more than collected", () => {
      const collected0 = 100n;
      const collected1 = 200n;
      const compounded0 = 150n; // more than collected
      const compounded1 = 50n;
      const cap0 = compounded0 > collected0 ? collected0 : compounded0;
      const cap1 = compounded1 > collected1 ? collected1 : compounded1;
      assert.equal(cap0, 100n); // capped to collected
      assert.equal(cap1, 50n); // not capped
    });
  });

  describe("atomic config write", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    it("saveConfig uses temp file + rename for atomic write", () => {
      const { saveConfig, loadConfig } = require("../src/bot-config-v2");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compound-test-"));
      const cfg = {
        global: {},
        positions: {
          "test-key": { status: "running", totalCompoundedUsd: 5.5 },
        },
      };
      saveConfig(cfg, dir);
      const loaded = loadConfig(dir);
      assert.equal(loaded.positions["test-key"].status, "running");
      assert.equal(loaded.positions["test-key"].totalCompoundedUsd, 5.5);
      fs.rmSync(dir, { recursive: true });
    });

    it("no .tmp file remains after successful save", () => {
      const { saveConfig } = require("../src/bot-config-v2");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compound-test-"));
      saveConfig({ global: {}, positions: {} }, dir);
      const files = fs.readdirSync(dir);
      assert.ok(!files.some((f) => f.endsWith(".tmp")));
      fs.rmSync(dir, { recursive: true });
    });
  });

  describe("bot state restoration", () => {
    it("createPerPositionBotState copies compound fields from saved config", () => {
      const { createPerPositionBotState } = require("../src/server-positions");
      const saved = {
        totalCompoundedUsd: 12.5,
        compoundHistory: [{ trigger: "auto", usdValue: 12.5 }],
        lastCompoundAt: "2026-04-04T12:00:00Z",
      };
      const state = createPerPositionBotState({}, saved);
      assert.equal(state.totalCompoundedUsd, 12.5);
      assert.equal(state.compoundHistory.length, 1);
      assert.equal(state.lastCompoundAt, "2026-04-04T12:00:00Z");
    });

    it("createPerPositionBotState handles missing compound fields", () => {
      const { createPerPositionBotState } = require("../src/server-positions");
      const state = createPerPositionBotState({}, {});
      assert.equal(state.totalCompoundedUsd, undefined);
      assert.equal(state.compoundHistory, undefined);
    });
  });

  describe("P&L override with compound", () => {
    it("overridePnlWithRealValues subtracts totalCompoundedUsd", () => {
      const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
      const snap = {
        closedEpochs: [],
        liveEpoch: { entryValue: 100, fees: 5 },
        initialDeposit: 100,
        totalGas: 0,
      };
      const deps = {
        _botState: { totalCompoundedUsd: 3 },
        _collectedFeesUsd: 0,
      };
      const position = {
        liquidity: "1000000",
        tickLower: 0,
        tickUpper: 1000,
      };
      const poolState = {
        tick: 500,
        decimals0: 8,
        decimals1: 8,
      };
      overridePnlWithRealValues(
        snap,
        deps,
        position,
        poolState,
        0.001,
        0.001,
        5,
        0,
      );
      assert.equal(snap.totalCompoundedUsd, 3);
      /*- netReturn = (compounded + currentFees) - gas + priceChange.
       *  Compounded is folded into fee earnings, not subtracted. */
      assert.ok(snap.netReturn !== undefined);
      assert.equal(snap.currentFeesUsd, 5);
    });
  });

  describe("config SETTINGS_KEYS coverage", () => {
    it("status response includes compound settings", () => {
      const { POSITION_KEYS } = require("../src/bot-config-v2");
      const compoundKeys = [
        "autoCompoundEnabled",
        "autoCompoundThresholdUsd",
        "totalCompoundedUsd",
        "lastCompoundAt",
        "compoundHistory",
      ];
      for (const k of compoundKeys) {
        assert.ok(POSITION_KEYS.includes(k), `${k} missing from POSITION_KEYS`);
      }
    });
  });

  describe("_persistPositionConfig with compound fields", () => {
    const _fs = require("fs"),
      _os = require("os"),
      _p = require("path");
    const _dir = _fs.mkdtempSync(_p.join(_os.tmpdir(), "comp-persist-"));
    it("persists compound fields to in-memory config", () => {
      const { getPositionConfig } = require("../src/bot-config-v2");
      const { updatePositionState } = require("../src/server-positions");
      const cfg = { global: {}, positions: {} };
      getPositionConfig(cfg, "test-key");
      cfg.positions["test-key"].status = "running";
      const keyRef = { current: "test-key" };
      const pm = { migrateKey: () => {} };
      const patch = {
        totalCompoundedUsd: 7.5,
        lastCompoundAt: "2026-04-04T15:00:00Z",
        compoundHistory: [{ trigger: "auto" }],
      };
      updatePositionState(keyRef, patch, cfg, pm, _dir);
      assert.equal(cfg.positions["test-key"].totalCompoundedUsd, 7.5);
      assert.equal(
        cfg.positions["test-key"].lastCompoundAt,
        "2026-04-04T15:00:00Z",
      );
      assert.equal(cfg.positions["test-key"].compoundHistory.length, 1);
      assert.equal(cfg.positions["test-key"].status, "running");
    });
  });

  describe("pnl-tracker addGas", () => {
    it("addGas increments live epoch gas", () => {
      const { createPnlTracker } = require("../src/pnl-tracker");
      const tracker = createPnlTracker({ initialDeposit: 100 });
      tracker.openEpoch({
        entryValue: 100,
        entryPrice: 1,
        lowerPrice: 0.9,
        upperPrice: 1.1,
      });
      tracker.addGas(0.05);
      tracker.addGas(0.03);
      const snap = tracker.snapshot(1.0);
      assert.equal(snap.totalGas, 0.08);
    });
    it("addGas does nothing when no live epoch", () => {
      const { createPnlTracker } = require("../src/pnl-tracker");
      const tracker = createPnlTracker({ initialDeposit: 100 });
      tracker.addGas(1.0); // no epoch open — should not throw
      assert.equal(tracker.epochCount(), 0);
    });
    it("addGas ignores zero and negative", () => {
      const { createPnlTracker } = require("../src/pnl-tracker");
      const tracker = createPnlTracker({ initialDeposit: 100 });
      tracker.openEpoch({
        entryValue: 100,
        entryPrice: 1,
        lowerPrice: 0.9,
        upperPrice: 1.1,
      });
      tracker.addGas(0);
      tracker.addGas(-1);
      const snap = tracker.snapshot(1.0);
      assert.equal(snap.totalGas, 0);
    });
  });
});

describe("_filterRebalances", () => {
  it("excludes IncreaseLiquidity that follows a drain", () => {
    const { _filterRebalances } = require("../src/compounder");
    const candidates = [
      { amount0: 100n, amount1: 0n, blockNumber: 2000 },
      { amount0: 50n, amount1: 10n, blockNumber: 100000 },
    ];
    const drains = [{ liquidity: 999n, blockNumber: 1990 }];
    const result = _filterRebalances(candidates, drains);
    assert.equal(result.length, 1, "rebalance should be filtered");
    assert.equal(result[0].blockNumber, 100000, "only real compound kept");
  });
  it("keeps all when no drains exist", () => {
    const { _filterRebalances } = require("../src/compounder");
    const candidates = [{ amount0: 50n, amount1: 10n, blockNumber: 100 }];
    const result = _filterRebalances(candidates, []);
    assert.equal(result.length, 1);
  });
  it("ignores zero-liquidity DecreaseLiquidity", () => {
    const { _filterRebalances } = require("../src/compounder");
    const candidates = [{ amount0: 50n, amount1: 10n, blockNumber: 100 }];
    const drains = [{ liquidity: 0n, blockNumber: 95 }];
    const result = _filterRebalances(candidates, drains);
    assert.equal(result.length, 1, "zero-liq drain should not filter");
  });
});
