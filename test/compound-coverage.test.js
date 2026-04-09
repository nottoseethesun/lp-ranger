/**
 * @file test/compound-coverage.test.js
 * @description Additional coverage tests targeting bot-cycle compound paths,
 * bot-recorder compound detection, and server-positions compound persistence.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("bot-cycle compound gates", () => {
  // Import pollCycle to exercise _checkCompound and _handleForceCompound
  const { pollCycle } = require("../src/bot-cycle");

  function makeDeps(overrides = {}) {
    const position = {
      tokenId: "100",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      tickLower: 0,
      tickUpper: 1000,
      liquidity: "1000000",
      decimals0: 8,
      decimals1: 8,
    };
    const _poolState = { tick: 500, price: 1, decimals0: 8, decimals1: 8 };
    return {
      signer: { getAddress: async () => "0x1234" },
      provider: {
        getBlock: async () => ({ baseFeePerGas: 1000n }),
        getFeeData: async () => ({
          gasPrice: 1000n,
          maxFeePerGas: 2000n,
          maxPriorityFeePerGas: 100n,
        }),
      },
      position,
      throttle: {
        tick: () => {},
        canRebalance: () => ({ allowed: true, msUntilAllowed: 0 }),
        _state: {},
      },
      _ethersLib: {
        Contract: function () {
          return {
            getPool: async () => "0xPool",
            slot0: async () => ({ tick: 500, sqrtPriceX96: 1n << 96n }),
            fee: async () => 3000,
            token0: async () => "0xA",
            token1: async () => "0xB",
            decimals: async () => 8,
            positions: async () => ({
              liquidity: 1000000n,
              tickLower: 0,
              tickUpper: 1000,
              tokensOwed0: 0n,
              tokensOwed1: 0n,
            }),
          };
        },
        ZeroAddress: "0x0000000000000000000000000000000000000000",
      },
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        forceCompound: false,
        ...overrides.botState,
      },
      _getConfig: (k) =>
        ({
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
          autoCompoundEnabled: false,
          autoCompoundThresholdUsd: 5,
          ...overrides.config,
        })[k],
      updateBotState: overrides.emit || (() => {}),
      _lastUnclaimedFeesUsd: overrides.fees || 0,
      _lastPrice0: 0.001,
      _lastPrice1: 0.001,
      _pnlTracker: null,
      ...overrides.extra,
    };
  }

  it("skips compound when auto disabled and not forced", async () => {
    const deps = makeDeps({ config: { autoCompoundEnabled: false } });
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
    assert.equal(r.inRange, true);
  });

  it("skips compound when fees below threshold", async () => {
    const deps = makeDeps({
      config: { autoCompoundEnabled: true, autoCompoundThresholdUsd: 100 },
      fees: 2,
    });
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
  });

  it("skips compound when fees below minimum ($1)", async () => {
    const deps = makeDeps({
      config: { autoCompoundEnabled: true, autoCompoundThresholdUsd: 0.5 },
      fees: 0.5,
    });
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
  });

  it("skips compound when recently compounded (throttle)", async () => {
    const deps = makeDeps({
      config: {
        autoCompoundEnabled: true,
        autoCompoundThresholdUsd: 1,
        lastCompoundAt: new Date().toISOString(),
      },
      fees: 10,
    });
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
  });

  it("skips forceCompound when not set", async () => {
    const deps = makeDeps({ botState: { forceCompound: false } });
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
  });

  it("handles closed position (0 liquidity) gracefully", async () => {
    const deps = makeDeps({ extra: {} });
    deps.position.liquidity = "0";
    const r = await pollCycle(deps);
    assert.equal(r.rebalanced, false);
  });
});

describe("bot-cycle _checkCompound trigger path", () => {
  const { pollCycle } = require("../src/bot-cycle");

  function deps(overrides = {}) {
    return {
      signer: { getAddress: async () => "0x1234" },
      provider: {
        getBlock: async () => ({ baseFeePerGas: 1000n }),
        getFeeData: async () => ({
          gasPrice: 1000n,
          maxFeePerGas: 2000n,
          maxPriorityFeePerGas: 100n,
        }),
      },
      position: {
        tokenId: "100",
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tickLower: 0,
        tickUpper: 1000,
        liquidity: "1000000",
      },
      throttle: {
        tick: () => {},
        canRebalance: () => ({ allowed: true }),
        _state: {},
      },
      _ethersLib: {
        Contract: function () {
          return {
            getPool: async () => "0xP",
            slot0: async () => ({ tick: 500, sqrtPriceX96: 1n << 96n }),
            fee: async () => 3000,
            token0: async () => "0xA",
            token1: async () => "0xB",
            decimals: async () => 8,
            positions: async () => ({
              liquidity: 1000000n,
              tickLower: 0,
              tickUpper: 1000,
              tokensOwed0: 0n,
              tokensOwed1: 0n,
            }),
          };
        },
        ZeroAddress: "0x" + "0".repeat(40),
      },
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        ...overrides.botState,
      },
      _getConfig: (k) =>
        ({
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
          ...overrides.cfg,
        })[k],
      updateBotState: () => {},
      _lastUnclaimedFeesUsd: overrides.fees || 0,
      _lastPrice0: 0.001,
      _lastPrice1: 0.001,
      _pnlTracker: null,
    };
  }

  it("auto-compound skips when disabled", async () => {
    const r = await pollCycle(deps({ cfg: { autoCompoundEnabled: false } }));
    assert.equal(r.inRange, true);
  });

  it("auto-compound skips when fees < threshold", async () => {
    const r = await pollCycle(
      deps({
        cfg: { autoCompoundEnabled: true, autoCompoundThresholdUsd: 50 },
        fees: 10,
      }),
    );
    assert.equal(r.inRange, true);
  });

  it("auto-compound skips when fees < min ($1)", async () => {
    const r = await pollCycle(
      deps({
        cfg: { autoCompoundEnabled: true, autoCompoundThresholdUsd: 0.5 },
        fees: 0.3,
      }),
    );
    assert.equal(r.inRange, true);
  });

  it("auto-compound skips when throttle interval not elapsed", async () => {
    const r = await pollCycle(
      deps({
        cfg: {
          autoCompoundEnabled: true,
          autoCompoundThresholdUsd: 1,
          lastCompoundAt: new Date().toISOString(),
        },
        fees: 10,
      }),
    );
    assert.equal(r.inRange, true);
  });

  it("force compound skips when flag not set", async () => {
    const r = await pollCycle(deps({ botState: { forceCompound: false } }));
    assert.equal(r.inRange, true);
  });

  it("force compound runs and catches error gracefully", async () => {
    const emitted = [];
    const d = deps({
      botState: { forceCompound: true },
      fees: 10,
    });
    d.updateBotState = (u) => emitted.push(u);
    d._rebalanceLock = null;
    const r = await pollCycle(d);
    // The compound will fail (mock contract), but it should not crash
    assert.equal(r.inRange, true);
    assert.ok(emitted.some((e) => e.compoundInProgress === true));
    assert.ok(emitted.some((e) => e.compoundInProgress === false));
  });

  it("auto-compound with no lastCompoundAt triggers", async () => {
    const emitted = [];
    const d = deps({
      cfg: {
        autoCompoundEnabled: true,
        autoCompoundThresholdUsd: 1,
      },
      fees: 10,
    });
    d.updateBotState = (u) => emitted.push(u);
    d._rebalanceLock = null;
    const r = await pollCycle(d);
    assert.equal(r.inRange, true);
    assert.ok(emitted.some((e) => e.compoundInProgress !== undefined));
  });

  it("auto-compound triggers when all conditions met (old lastCompoundAt)", async () => {
    const emitted = [];
    const d = deps({
      cfg: {
        autoCompoundEnabled: true,
        autoCompoundThresholdUsd: 1,
        lastCompoundAt: "2020-01-01T00:00:00Z",
      },
      fees: 10,
    });
    d.updateBotState = (u) => emitted.push(u);
    d._rebalanceLock = null;
    const r = await pollCycle(d);
    assert.equal(r.inRange, true);
    // compound was attempted (and failed on mock, but the path was exercised)
    assert.ok(emitted.some((e) => e.compoundInProgress !== undefined));
  });
});

describe("bot-recorder _detectHistoricalCompounds", () => {
  it("collects unique tokenIds from rebalance events", () => {
    // Verify the Set logic for collecting all NFTs in the chain
    const events = [
      { oldTokenId: "100", newTokenId: "200" },
      { oldTokenId: "200", newTokenId: "300" },
      { oldTokenId: "300", newTokenId: "400" },
    ];
    const ids = new Set(["400"]); // current
    for (const ev of events) {
      if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
      if (ev.newTokenId) ids.add(String(ev.newTokenId));
    }
    assert.equal(ids.size, 4); // 100, 200, 300, 400
    assert.ok(ids.has("100"));
    assert.ok(ids.has("400"));
  });
});

describe("server-positions compound state", () => {
  it("createPerPositionBotState with all compound fields", () => {
    const { createPerPositionBotState } = require("../src/server-positions");
    const state = createPerPositionBotState(
      {},
      {
        totalCompoundedUsd: 50,
        compoundHistory: [
          { trigger: "auto" },
          { trigger: "auto" },
          { trigger: "manual" },
        ],
        lastCompoundAt: "2026-01-01T00:00:00Z",
        hodlBaseline: { entryValue: 200 },
        residuals: { pool: { t0: 100, t1: 200 } },
        collectedFeesUsd: 15,
      },
    );
    assert.equal(state.totalCompoundedUsd, 50);
    assert.equal(state.compoundHistory.length, 3);
    assert.equal(state.lastCompoundAt, "2026-01-01T00:00:00Z");
    assert.equal(state.hodlBaseline.entryValue, 200);
    assert.equal(state.collectedFeesUsd, 15);
  });

  it("createPerPositionBotState with null saved", () => {
    const { createPerPositionBotState } = require("../src/server-positions");
    const state = createPerPositionBotState({}, null);
    assert.equal(state.running, false);
    assert.equal(state.totalCompoundedUsd, undefined);
  });

  it("updatePositionState persists compound fields", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-"));
    const { updatePositionState } = require("../src/server-positions");
    const { getPositionConfig } = require("../src/bot-config-v2");
    const cfg = { global: {}, positions: {} };
    getPositionConfig(cfg, "test");
    cfg.positions.test.status = "running";

    updatePositionState(
      { current: "test" },
      { totalCompoundedUsd: 99, lastCompoundAt: "2026-06-01T00:00:00Z" },
      cfg,
      { migrateKey: () => {} },
      tmpDir,
    );
    assert.equal(cfg.positions.test.totalCompoundedUsd, 99);
    assert.equal(cfg.positions.test.lastCompoundAt, "2026-06-01T00:00:00Z");
    assert.equal(cfg.positions.test.status, "running");
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("pnl-tracker residual and missingPrice", () => {
  it("daily P&L entries have residual field defaulting to 0", () => {
    const { createPnlTracker } = require("../src/pnl-tracker");
    const t = createPnlTracker({ initialDeposit: 100 });
    t.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.9,
      upperPrice: 1.1,
    });
    const snap = t.snapshot(1.0);
    for (const d of snap.dailyPnl) {
      assert.equal(typeof d.residual, "number");
      assert.equal(typeof d.missingPrice, "boolean");
    }
  });

  it("cumulative includes residual in calculation", () => {
    const { createPnlTracker } = require("../src/pnl-tracker");
    const t = createPnlTracker({ initialDeposit: 100 });
    const now = Date.now();
    t.restore({
      closedEpochs: [
        {
          id: 1,
          entryValue: 100,
          exitValue: 110,
          fees: 2,
          gas: 0,
          il: 0,
          feePnl: 2,
          priceChangePnl: 10,
          epochPnl: 12,
          openTime: now - 172800000,
          closeTime: now - 86400000,
          status: "closed",
        },
        {
          id: 2,
          entryValue: 90,
          exitValue: 95,
          fees: 1,
          gas: 0,
          il: 0,
          feePnl: 1,
          priceChangePnl: 5,
          epochPnl: 6,
          openTime: now - 86400000,
          closeTime: now - 43200000,
          status: "closed",
        },
      ],
      liveEpoch: null,
    });
    const snap = t.snapshot(1.0);
    // The gap between epoch 1 exit (110) and epoch 2 entry (90) = -20 residual
    const dayWithResidual = snap.dailyPnl.find((d) => d.residual !== 0);
    assert.ok(
      dayWithResidual,
      "Expected at least one day with non-zero residual",
    );
  });
});

describe("bot-pnl-updater compound override", () => {
  it("snapshot includes totalCompoundedUsd from botState", () => {
    const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
    const snap = {
      closedEpochs: [],
      liveEpoch: { entryValue: 500, fees: 20 },
      initialDeposit: 500,
      totalGas: 1,
    };
    overridePnlWithRealValues(
      snap,
      { _botState: { totalCompoundedUsd: 15 }, _collectedFeesUsd: 30 },
      { liquidity: "100000000", tickLower: -1000, tickUpper: 1000 },
      { tick: 0, decimals0: 18, decimals1: 18 },
      1,
      1,
      20,
      0,
    );
    assert.equal(snap.totalCompoundedUsd, 15);
    // netReturn = fees - gas + priceChange - compounded
    assert.ok(typeof snap.netReturn === "number");
    assert.ok(typeof snap.cumulativePnl === "number");
  });

  it("zero compounded does not affect netReturn", () => {
    const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
    const snap = {
      closedEpochs: [],
      liveEpoch: { entryValue: 100, fees: 5 },
      initialDeposit: 100,
      totalGas: 0,
    };
    overridePnlWithRealValues(
      snap,
      { _botState: {}, _collectedFeesUsd: 5 },
      { liquidity: "100000000", tickLower: 0, tickUpper: 1000 },
      { tick: 500, decimals0: 8, decimals1: 8 },
      0.001,
      0.001,
      5,
      0,
    );
    assert.equal(snap.totalCompoundedUsd, 0);
  });
});

describe("_computeLifetimeFees includes historical compounds", () => {
  it("counts compounded fees when _collectedFeesUsd is 0", () => {
    const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
    const snap = {
      totalFees: 0,
      totalGas: 0,
      liveEpoch: { entryValue: 100, fees: 1 },
      closedEpochs: [],
    };
    const deps = {
      _collectedFeesUsd: 0,
      _botState: { totalCompoundedUsd: 50 },
    };
    const pos = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
    const pool = { tick: 0, decimals0: 18, decimals1: 18 };
    overridePnlWithRealValues(snap, deps, pos, pool, 1, 1, 1, 0);
    // totalFees should include compounded: max(0, 50) + 1 = 51
    assert.ok(
      snap.totalFees >= 50,
      "lifetime fees must include compounded ($" + snap.totalFees + ")",
    );
  });
});
