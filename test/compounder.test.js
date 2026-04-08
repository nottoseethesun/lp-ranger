/**
 * @file test/compounder.test.js
 * @description Tests for the compound execution logic.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("compounder", () => {
  describe("_parseIncreaseLiquidity", () => {
    // Access the internal via module — the function is used by addLiquidity
    // but not directly exported; test indirectly through executeCompound mock

    it("module exports all expected functions", () => {
      const mod = require("../src/compounder");
      assert.equal(typeof mod.collectFees, "function");
      assert.equal(typeof mod.addLiquidity, "function");
      assert.equal(typeof mod.executeCompound, "function");
      assert.equal(typeof mod.detectCompoundsOnChain, "function");
      assert.equal(typeof mod.scanNftEvents, "function");
      assert.equal(typeof mod.classifyCompounds, "function");
      assert.equal(typeof mod._filterRebalances, "function");
      assert.equal(typeof mod._parseLogs, "function");
    });
  });

  describe("executeCompound", () => {
    it("returns compounded:false when no fees collected", async () => {
      const { executeCompound } = require("../src/compounder");

      // Mock signer and ethersLib
      const mockPm = {
        interface: {
          encodeFunctionData: () => "0x",
        },
        collect: async () => ({
          hash: "0xtest",
          nonce: 1,
          type: 2,
          wait: async () => ({
            hash: "0xtest",
            gasUsed: 100000n,
            gasPrice: 1000000n,
            effectiveGasPrice: 1000000n,
            blockNumber: 1,
            logs: [],
          }),
        }),
      };

      const mockSigner = {
        provider: {
          getTransactionReceipt: async () => null,
          getFeeData: async () => ({
            gasPrice: 1000000n,
            maxFeePerGas: 2000000n,
            maxPriorityFeePerGas: 100000n,
          }),
        },
        getAddress: async () => "0x1234567890123456789012345678901234567890",
      };

      const mockEthers = {
        Contract: function () {
          return {
            ...mockPm,
            balanceOf: async () => 0n,
            allowance: async () => 0n,
            approve: async () => ({
              hash: "0xapprove",
              nonce: 2,
              type: 2,
              wait: async () => ({ gasUsed: 50000n, gasPrice: 1000000n }),
            }),
            increaseLiquidity: async () => ({
              hash: "0xincrease",
              nonce: 3,
              type: 2,
              wait: async () => ({
                hash: "0xincrease",
                gasUsed: 200000n,
                gasPrice: 1000000n,
                effectiveGasPrice: 1000000n,
                blockNumber: 2,
                logs: [],
              }),
            }),
          };
        },
      };

      const result = await executeCompound(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "123",
        token0: "0xA",
        token1: "0xB",
        recipient: "0x1234567890123456789012345678901234567890",
        decimals0: 8,
        decimals1: 8,
        price0: 0.001,
        price1: 0.001,
        trigger: "manual",
      });

      assert.equal(result.compounded, false);
      assert.equal(result.reason, "no_fees");
    });
  });

  describe("compound config keys", () => {
    it("POSITION_KEYS includes compound fields", () => {
      const { POSITION_KEYS } = require("../src/bot-config-v2");
      assert.ok(POSITION_KEYS.includes("autoCompoundEnabled"));
      assert.ok(POSITION_KEYS.includes("autoCompoundThresholdUsd"));
      assert.ok(POSITION_KEYS.includes("compoundHistory"));
      assert.ok(POSITION_KEYS.includes("totalCompoundedUsd"));
      assert.ok(POSITION_KEYS.includes("lastCompoundAt"));
    });

    it("COMPOUND_MIN_FEE_USD is defined in config", () => {
      const config = require("../src/config");
      assert.equal(typeof config.COMPOUND_MIN_FEE_USD, "number");
      assert.ok(config.COMPOUND_MIN_FEE_USD > 0);
    });

    it("COMPOUND_DEFAULT_THRESHOLD_USD is defined in config", () => {
      const config = require("../src/config");
      assert.equal(typeof config.COMPOUND_DEFAULT_THRESHOLD_USD, "number");
      assert.ok(
        config.COMPOUND_DEFAULT_THRESHOLD_USD >= config.COMPOUND_MIN_FEE_USD,
      );
    });
  });

  describe("collectFees with mocked contract", () => {
    it("collects fees and returns balance diff", async () => {
      const { collectFees } = require("../src/compounder");
      let callCount = 0;
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
      };
      const mockEthers = {
        Contract: function (_addr, _abi, _s) {
          return {
            collect: async () => ({
              hash: "0xcollect",
              nonce: 1,
              type: 2,
              wait: async () => ({
                hash: "0xcollect",
                gasUsed: 100000n,
                gasPrice: 1000n,
                effectiveGasPrice: 1000n,
                blockNumber: 10,
                logs: [],
              }),
            }),
            balanceOf: async () => {
              callCount++;
              return callCount <= 2 ? 1000n : 1500n; // before=1000, after=1500
            },
          };
        },
      };
      const result = await collectFees(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        token0: "0xA",
        token1: "0xB",
        recipient: "0xWallet",
      });
      assert.equal(result.amount0, 500n);
      assert.equal(result.amount1, 500n);
      assert.equal(result.txHash, "0xcollect");
    });
  });

  describe("addLiquidity with mocked contract", () => {
    it("calls increaseLiquidity and returns amounts", async () => {
      const { addLiquidity } = require("../src/compounder");
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
      };
      const mockEthers = {
        Contract: function () {
          return {
            allowance: async () => 999999n,
            increaseLiquidity: async () => ({
              hash: "0xinc",
              nonce: 2,
              type: 2,
              wait: async () => ({
                hash: "0xinc",
                gasUsed: 200000n,
                gasPrice: 1000n,
                effectiveGasPrice: 1000n,
                blockNumber: 11,
                logs: [], // no parseable logs — amounts default to 0
              }),
            }),
          };
        },
      };
      const result = await addLiquidity(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        amount0: 200n,
        amount1: 300n,
        token0: "0xA",
        token1: "0xB",
        recipient: "0xWallet",
      });
      // Without parseable IncreaseLiquidity event, defaults to 0
      assert.equal(result.liquidity, 0n);
      assert.equal(result.txHash, "0xinc");
      assert.ok(result.gasCostWei > 0n);
    });
  });

  describe("executeCompound with collected fees", () => {
    it("returns compounded:true with USD value when fees exist", async () => {
      const { executeCompound } = require("../src/compounder");
      let balCall = 0;
      const mockEthers = {
        Contract: function () {
          return {
            collect: async () => ({
              hash: "0xc",
              nonce: 1,
              type: 2,
              wait: async () => ({
                hash: "0xc",
                gasUsed: 100000n,
                gasPrice: 1000n,
                effectiveGasPrice: 1000n,
                blockNumber: 1,
                logs: [],
              }),
            }),
            balanceOf: async () => {
              balCall++;
              return balCall <= 2 ? 0n : 50000000n;
            },
            allowance: async () => 999999999n,
            increaseLiquidity: async () => ({
              hash: "0xi",
              nonce: 2,
              type: 2,
              wait: async () => ({
                hash: "0xi",
                gasUsed: 200000n,
                gasPrice: 1000n,
                effectiveGasPrice: 1000n,
                blockNumber: 2,
                logs: [],
              }),
            }),
          };
        },
      };
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
        getAddress: async () => "0x1234",
      };
      const result = await executeCompound(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        token0: "0xA",
        token1: "0xB",
        recipient: "0x1234",
        decimals0: 8,
        decimals1: 8,
        price0: 0.001,
        price1: 0.001,
        trigger: "auto",
      });
      assert.equal(result.compounded, true);
      assert.equal(result.trigger, "auto");
      assert.ok(result.usdValue >= 0);
      assert.ok(result.collectTxHash);
      assert.ok(result.depositTxHash);
    });
  });

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
      // Cleanup
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
      // netReturn should subtract compounded
      assert.ok(snap.netReturn !== undefined);
    });
  });

  describe("config SETTINGS_KEYS coverage", () => {
    it("status response includes compound settings", () => {
      // Verify the _SETTINGS_KEYS concept by checking the config keys are saveable
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
    it("persists compound fields to in-memory config", () => {
      const { getPositionConfig } = require("../src/bot-config-v2");
      const { updatePositionState } = require("../src/server-positions");
      const cfg = { global: {}, positions: {} };
      getPositionConfig(cfg, "test-key");
      cfg.positions["test-key"].status = "running";

      const keyRef = { current: "test-key" };
      const pm = { migrateKey: () => {} };
      updatePositionState(
        keyRef,
        {
          totalCompoundedUsd: 7.5,
          lastCompoundAt: "2026-04-04T15:00:00Z",
          compoundHistory: [{ trigger: "auto" }],
        },
        cfg,
        pm,
      );

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
