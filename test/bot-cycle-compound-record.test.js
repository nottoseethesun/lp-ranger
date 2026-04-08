/**
 * @file test/bot-cycle-compound-record.test.js
 * @description Tests for recordCompound in bot-cycle-compound.js.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

describe("recordCompound", () => {
  let recordCompound;
  const _origRequire = Module.prototype.require;
  let _mockGasCost = 0;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          actualGasCostUsd: async () => _mockGasCost,
          estimateGasCostUsd: async () => 0,
          positionValueUsd: () => 0,
          fetchTokenPrices: async () => ({ price0: 0, price1: 0 }),
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
    ({ recordCompound } = require("../src/bot-cycle-compound"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
  });

  it("records compound with gas cost and updates history", async () => {
    _mockGasCost = 1.5;
    const patches = [];
    let collectedFees = 0;
    const deps = {
      updateBotState: (p) => patches.push(p),
      _getConfig: (k) => {
        if (k === "compoundHistory") return [];
        if (k === "totalCompoundedUsd") return 10;
        return undefined;
      },
      _pnlTracker: {
        epochCount: () => 1,
        addGas: () => {},
        serialize: () => ({ closedEpochs: [] }),
      },
      _addCollectedFees: (v) => (collectedFees = v),
    };
    const result = {
      timestamp: "2026-04-01T12:00:00Z",
      depositTxHash: "0xhash",
      amount0Deposited: "1000",
      amount1Deposited: "500",
      usdValue: 5.0,
      price0: 0.003,
      price1: 0.001,
      gasCostWei: "100000000000000000",
      trigger: "auto",
    };
    await recordCompound(deps, result);
    // Should have emitted compound history and P&L patches
    const histPatch = patches.find((p) => p.compoundHistory);
    assert.ok(histPatch);
    assert.strictEqual(histPatch.compoundHistory.length, 1);
    assert.strictEqual(histPatch.compoundHistory[0].txHash, "0xhash");
    assert.strictEqual(histPatch.compoundHistory[0].gasCostUsd, 1.5);
    assert.strictEqual(histPatch.totalCompoundedUsd, 15); // 10 + 5
    assert.strictEqual(collectedFees, 5.0);
  });

  it("handles zero gas cost", async () => {
    _mockGasCost = 0;
    const patches = [];
    const deps = {
      updateBotState: (p) => patches.push(p),
      _getConfig: () => undefined,
    };
    const result = {
      timestamp: "2026-04-01T12:00:00Z",
      usdValue: 2.0,
      gasCostWei: "0",
      trigger: "manual",
    };
    await recordCompound(deps, result);
    const histPatch = patches.find((p) => p.compoundHistory);
    assert.ok(histPatch);
    assert.strictEqual(histPatch.compoundHistory[0].gasCostUsd, 0);
  });

  it("adds gas to P&L tracker when tracker has epochs", async () => {
    _mockGasCost = 0.5;
    let gasAdded = false;
    const deps = {
      updateBotState: () => {},
      _getConfig: () => undefined,
      _pnlTracker: {
        epochCount: () => 2,
        addGas: () => (gasAdded = true),
        serialize: () => ({}),
      },
    };
    await recordCompound(deps, {
      usdValue: 1,
      gasCostWei: "50000000000000000",
      trigger: "auto",
    });
    assert.ok(gasAdded);
  });

  it("skips P&L tracker gas when no epochs", async () => {
    _mockGasCost = 0.5;
    let gasAdded = false;
    const deps = {
      updateBotState: () => {},
      _getConfig: () => undefined,
      _pnlTracker: {
        epochCount: () => 0,
        addGas: () => (gasAdded = true),
        serialize: () => ({}),
      },
    };
    await recordCompound(deps, {
      usdValue: 1,
      gasCostWei: "50000000000000000",
      trigger: "auto",
    });
    assert.ok(!gasAdded);
  });
});
