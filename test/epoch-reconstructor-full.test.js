/**
 * @file test/epoch-reconstructor-full.test.js
 * @description Tests for the full reconstructEpochs flow with mocked
 *   getPositionHistory and actualGasCostUsd dependencies.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

describe("reconstructEpochs full flow", () => {
  let reconstructEpochs;
  const _origRequire = Module.prototype.require;
  let _mockHistory = {};
  let _mockGasCost = 0;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./position-history") {
        return {
          getPositionHistory: async (tokenId) => {
            if (_mockHistory[tokenId]) return _mockHistory[tokenId];
            throw new Error("unknown token " + tokenId);
          },
        };
      }
      if (id === "./bot-pnl-updater") {
        return {
          actualGasCostUsd: async () => _mockGasCost,
          positionValueUsd: () => 100,
          fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
          readUnclaimedFees: async () => ({
            tokensOwed0: 0n,
            tokensOwed1: 0n,
          }),
          addPoolShare: async () => {},
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
    ({ reconstructEpochs } = require("../src/epoch-reconstructor"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
  });

  /** Minimal mock tracker. */
  function mockTracker(existing) {
    const closed = existing || [];
    let data = { closedEpochs: closed, liveEpoch: null };
    return {
      serialize: () => data,
      restore: (d) => {
        data = d;
      },
      epochCount: () => data.closedEpochs?.length || 0,
    };
  }

  it("reconstructs epochs from chain when no cache exists", async () => {
    _mockHistory = {
      50: {
        mintDate: "2026-01-01T00:00:00Z",
        closeDate: "2026-01-02T00:00:00Z",
        entryValueUsd: 100,
        exitValueUsd: 95,
        feesEarnedUsd: 2,
      },
      51: {
        mintDate: "2026-01-02T00:00:00Z",
        closeDate: "2026-01-03T00:00:00Z",
        entryValueUsd: 95,
        exitValueUsd: 90,
        feesEarnedUsd: 1.5,
      },
    };
    _mockGasCost = 0;
    const tracker = mockTracker();
    const patches = [];
    const count = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [
        { oldTokenId: "50", newTokenId: "51" },
        { oldTokenId: "51", newTokenId: "52" },
      ],
      botState: {
        activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
        walletAddress: "0xW",
        positionManager: "0xPM",
      },
      updateBotState: (p) => patches.push(p),
    });
    assert.strictEqual(count, 2);
    // Verify tracker was restored with sorted epochs
    const data = tracker.serialize();
    assert.strictEqual(data.closedEpochs.length, 2);
    assert.strictEqual(data.closedEpochs[0].id, 1);
    assert.strictEqual(data.closedEpochs[1].id, 2);
  });

  it("handles gas cost conversion from gasCostWei", async () => {
    _mockHistory = {
      60: {
        mintDate: "2026-02-01T00:00:00Z",
        closeDate: "2026-02-02T00:00:00Z",
        entryValueUsd: 200,
        exitValueUsd: 195,
        feesEarnedUsd: 3,
        gasCostWei: "1000000000000000000", // 1 ETH in wei
      },
    };
    _mockGasCost = 2.5;
    const tracker = mockTracker();
    const count = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "60", newTokenId: "61" }],
      botState: { activePosition: null },
    });
    assert.strictEqual(count, 1);
    const ep = tracker.serialize().closedEpochs[0];
    assert.strictEqual(ep.gas, 2.5);
    assert.strictEqual(ep.gasNative, 1);
  });

  it("skips positions that throw errors", async () => {
    _mockHistory = {
      70: {
        mintDate: "2026-03-01T00:00:00Z",
        closeDate: "2026-03-02T00:00:00Z",
        entryValueUsd: 100,
        exitValueUsd: 100,
        feesEarnedUsd: 1,
      },
      // "71" not in mock → will throw
    };
    _mockGasCost = 0;
    const tracker = mockTracker();
    const count = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [
        { oldTokenId: "70", newTokenId: "71" },
        { oldTokenId: "71", newTokenId: "72" },
      ],
      botState: { activePosition: null },
    });
    assert.strictEqual(count, 1);
  });

  it("reports progress via updateBotState", async () => {
    _mockHistory = {
      80: {
        mintDate: "2026-04-01T00:00:00Z",
        closeDate: "2026-04-02T00:00:00Z",
        entryValueUsd: 50,
        exitValueUsd: 48,
        feesEarnedUsd: 0.5,
      },
    };
    _mockGasCost = 0;
    const tracker = mockTracker();
    const patches = [];
    await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "80", newTokenId: "81" }],
      botState: { activePosition: null },
      updateBotState: (p) => patches.push(p),
    });
    // Should have progress patch + final pnlEpochs patch
    const progressPatches = patches.filter((p) => p.rebalanceScanProgress);
    assert.ok(progressPatches.length >= 1);
    const epochPatches = patches.filter((p) => p.pnlEpochs);
    assert.ok(epochPatches.length >= 1);
  });

  it("skips incomplete history data (null exitValue)", async () => {
    _mockHistory = {
      90: {
        mintDate: "2026-05-01T00:00:00Z",
        closeDate: "2026-05-02T00:00:00Z",
        entryValueUsd: 100,
        exitValueUsd: null,
        feesEarnedUsd: 0,
      },
    };
    _mockGasCost = 0;
    const tracker = mockTracker();
    const count = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "90", newTokenId: "91" }],
      botState: { activePosition: null },
    });
    assert.strictEqual(count, 0);
  });

  it("returns 0 when all fetched epochs are empty", async () => {
    _mockHistory = {};
    _mockGasCost = 0;
    const tracker = mockTracker();
    const count = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "999", newTokenId: "1000" }],
      botState: { activePosition: null },
    });
    assert.strictEqual(count, 0);
  });

  it("passes fallbackPrices to getPositionHistory", async () => {
    let capturedOpts = null;
    Module.prototype.require = function (id) {
      if (id === "./position-history") {
        return {
          getPositionHistory: async (_tid, opts) => {
            capturedOpts = opts;
            return {
              mintDate: "2026-01-01T00:00:00Z",
              closeDate: "2026-01-02T00:00:00Z",
              entryValueUsd: 100,
              exitValueUsd: 100,
              feesEarnedUsd: 0,
            };
          },
        };
      }
      if (id === "./bot-pnl-updater") {
        return {
          actualGasCostUsd: async () => 0,
          positionValueUsd: () => 0,
          fetchTokenPrices: async () => ({ price0: 0, price1: 0 }),
          readUnclaimedFees: async () => ({
            tokensOwed0: 0n,
            tokensOwed1: 0n,
          }),
          addPoolShare: async () => {},
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
    const mod = require("../src/epoch-reconstructor");
    const tracker = mockTracker();
    const fb = { price0: 0.5, price1: 0.3 };
    await mod.reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "100", newTokenId: "101" }],
      botState: {
        activePosition: {
          token0: `0xFB${process.pid}`,
          token1: "0xFB1",
          fee: 500,
        },
      },
      fallbackPrices: fb,
    });
    assert.ok(capturedOpts);
    assert.strictEqual(capturedOpts.fallbackPrices, fb);
  });
});
