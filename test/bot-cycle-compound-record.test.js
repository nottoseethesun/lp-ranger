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
    const deps = {
      updateBotState: (p) => patches.push(p),
      _getConfig: (k) => {
        if (k === "compoundHistory") return [];
        if (k === "compoundedAmount0") return 10;
        if (k === "compoundedAmount1") return 20;
        return undefined;
      },
      _pnlTracker: {
        epochCount: () => 1,
        addGas: () => {},
        serialize: () => ({ closedEpochs: [] }),
      },
    };
    const result = {
      timestamp: "2026-04-01T12:00:00Z",
      depositTxHash: "0xhash",
      amount0Deposited: "1000",
      amount1Deposited: "500",
      depositedAmount0: 2,
      depositedAmount1: 3,
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
    /*- The coins are added, never a dollar total: the saved figure is
     *  priced by whoever shows it. */
    assert.strictEqual(histPatch.compoundedAmount0, 12); // 10 + 2
    assert.strictEqual(histPatch.compoundedAmount1, 23); // 20 + 3
    assert.strictEqual(histPatch.totalCompoundedUsd, undefined);
  });

  it("drops this NFT's cached Current-panel figures so the next poll rescans", async () => {
    /*-
     *  The Current panel reads `nftCompoundedAmountsByTokenId[tokenId]`
     *  and `nftGasWeiByTokenId[tokenId]`. A compound just changed both,
     *  and neither is recomputed here — `applyCurrentNftFigures` refills
     *  them, but only on a cache MISS. Left in place, the panel keeps
     *  showing the pre-compound figure until a rebalance or a Reload.
     *
     *  Other NFTs in the chain are untouched: their figures are still
     *  correct, and dropping them would buy a per-NFT rescan for nothing.
     */
    _mockGasCost = 0;
    const patches = [];
    const deps = {
      position: { tokenId: 12345 },
      updateBotState: (p) => patches.push(p),
      _getConfig: (k) => {
        if (k === "nftGasWeiByTokenId") return { 12345: "999", 999: "keep-me" };
        if (k === "nftCompoundedAmountsByTokenId")
          return {
            12345: { amount0: 1, amount1: 1 },
            999: { amount0: 7, amount1: 7 },
          };
        return undefined;
      },
    };
    await recordCompound(deps, {
      timestamp: "2026-04-01T12:00:00Z",
      depositedAmount0: 2,
      depositedAmount1: 3,
      usdValue: 5,
      gasCostWei: "0",
      trigger: "auto",
    });
    const patch = patches.find((p) => p.nftCompoundedAmountsByTokenId);
    assert.ok(patch, "a patch carrying the per-NFT maps must be emitted");
    assert.strictEqual(
      patch.nftCompoundedAmountsByTokenId["12345"],
      undefined,
      "the compounded NFT's coins must be dropped",
    );
    assert.strictEqual(
      patch.nftGasWeiByTokenId["12345"],
      undefined,
      "the compounded NFT's gas must be dropped",
    );
    assert.deepStrictEqual(
      patch.nftCompoundedAmountsByTokenId["999"],
      { amount0: 7, amount1: 7 },
      "another NFT's coins must survive",
    );
    assert.strictEqual(patch.nftGasWeiByTokenId["999"], "keep-me");
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
