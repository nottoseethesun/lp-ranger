/**
 * @file test/bot-recorder-epoch.test.js
 * @description Tests for _closePnlEpoch in bot-recorder.js with mocked
 *   dependencies (bot-pnl-updater, epoch-cache).
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const { createPnlTracker } = require("../src/pnl-tracker");

describe("_closePnlEpoch", () => {
  let _closePnlEpoch;
  const _origRequire = Module.prototype.require;
  let _mockGasCost = 0;
  let _mockPrices = { price0: 1, price1: 1 };

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          toFloat: (val, dec) => Number(val) / 10 ** (dec ?? 18),
          fetchTokenPrices: async () => _mockPrices,
          estimateGasCostUsd: async () => _mockGasCost,
          actualGasCostUsd: async () => _mockGasCost,
          positionValueUsd: () => 0,
          addPoolShare: async () => {},
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-recorder")];
    ({ _closePnlEpoch } = require("../src/bot-recorder"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-recorder")];
  });

  it("returns early when no tracker", async () => {
    await _closePnlEpoch({ _pnlTracker: null }, {});
    // No error thrown
  });

  it("returns early when tracker has 0 epochs", async () => {
    const tracker = createPnlTracker({ initialDeposit: 0 });
    await _closePnlEpoch({ _pnlTracker: tracker }, {});
    // Still 0 epochs
    assert.strictEqual(tracker.epochCount(), 0);
  });

  it("closes epoch and opens new one with USD prices", async () => {
    _mockGasCost = 0.5;
    _mockPrices = { price0: 2, price1: 0.5 };
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      token0UsdPrice: 2,
      token1UsdPrice: 0.5,
    });
    const patches = [];
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
      updateBotState: (p) => patches.push(p),
    };
    const result = {
      token0UsdPrice: 2.1,
      token1UsdPrice: 0.48,
      exitValueUsd: 95,
      totalGasCostWei: BigInt("100000000000000000"),
      amount0Minted: BigInt("1000000000000000000"),
      amount1Minted: BigInt("2000000000000000000"),
      currentPrice: 1.05,
      newTickLower: -100,
      newTickUpper: 100,
      decimals0: 18,
      decimals1: 18,
    };
    await _closePnlEpoch(deps, result);
    // Should have a closed epoch + new open epoch
    assert.ok(patches.length > 0);
    const snap = tracker.snapshot(1);
    assert.ok(snap);
    assert.ok(snap.closedEpochs.length >= 1);
  });

  it("clears the unclaimed-fee amounts with the figure they produced", async () => {
    /*- A rebalance sweeps unclaimed fees into the new position, so
     *  `_lastUnclaimedFeesUsd` is zeroed to say they are no longer
     *  owed. The token amounts behind it must go with it: they are what
     *  `_freshFeesUsd` (src/bot-cycle-compound.js) re-values when
     *  deciding whether to compound, and left standing they describe
     *  fees this rebalance already collected as still available —
     *  which is a compound spending gas to collect nothing.
     *
     *  The poll refreshes all three before that decision is reached, so
     *  this pins an invariant rather than a reachable fault. The three
     *  have to move together, or the next reader of one gets an answer
     *  the others contradict. */
    _mockGasCost = 0;
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      token0UsdPrice: 2,
      token1UsdPrice: 0.5,
    });
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
      updateBotState: () => {},
      _lastUnclaimedFeesUsd: 7,
      _lastUnclaimedFee0: 10,
      _lastUnclaimedFee1: 4,
    };
    await _closePnlEpoch(deps, {
      token0UsdPrice: 2,
      token1UsdPrice: 0.5,
      exitValueUsd: 95,
      totalGasCostWei: 0n,
      amount0Minted: 0n,
      amount1Minted: 0n,
      currentPrice: 1,
      newTickLower: -100,
      newTickUpper: 100,
      decimals0: 18,
      decimals1: 18,
    });
    assert.strictEqual(deps._lastUnclaimedFeesUsd, 0, "the USD figure");
    assert.strictEqual(deps._lastUnclaimedFee0, 0, "and both amounts");
    assert.strictEqual(deps._lastUnclaimedFee1, 0, "and both amounts");
  });

  it("fetches prices when not provided in result", async () => {
    _mockGasCost = 0;
    _mockPrices = { price0: 3, price1: 1.5 };
    const tracker = createPnlTracker({ initialDeposit: 50 });
    tracker.openEpoch({
      entryValue: 50,
      entryPrice: 1,
      lowerPrice: 0.5,
      upperPrice: 1.5,
    });
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xX", token1: "0xY" },
      provider: {},
    };
    const result = {
      // No token0UsdPrice or token1UsdPrice → triggers fetch
      exitValueUsd: 48,
      amount0Minted: 0n,
      amount1Minted: 0n,
      currentPrice: 2,
      newTickLower: -50,
      newTickUpper: 50,
    };
    await _closePnlEpoch(deps, result);
    const snap = tracker.snapshot(2);
    assert.ok(snap.closedEpochs.length >= 1);
  });

  it("adds collected fees when available", async () => {
    _mockGasCost = 0;
    _mockPrices = { price0: 1, price1: 1 };
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.5,
      upperPrice: 1.5,
    });
    const patches = [];
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
      _lastUnclaimedFeesUsd: 5.5,
      _lastUnclaimedFee0: 2,
      _lastUnclaimedFee1: 3.5,
      /*- A total the chain scan already established. Without one there is
       *  nothing to credit onto: the coins mean the whole chain's, and
       *  only the classification can say what that is — see
       *  test/lifetime-compounded-establishment.test.js. */
      _botState: { compoundedAmount0: 1, compoundedAmount1: 0.5 },
      updateBotState: (p) => patches.push(p),
    };
    const result = {
      token0UsdPrice: 1,
      token1UsdPrice: 1,
      exitValueUsd: 100,
      amount0Minted: 0n,
      amount1Minted: 0n,
      currentPrice: 1,
      newTickLower: -100,
      newTickUpper: 100,
    };
    await _closePnlEpoch(deps, result);
    /*- The fees this rebalance swept back in are credited as coins. */
    const patch = patches.find((p) => "compoundedAmount0" in p);
    assert.strictEqual(patch.compoundedAmount0, 3); // 1 + 2
    assert.strictEqual(patch.compoundedAmount1, 4); // 0.5 + 3.5
    assert.strictEqual(deps._lastUnclaimedFeesUsd, 0);
  });

  it("bumps the compounded coins by rebalance-time fees", async () => {
    _mockGasCost = 0;
    _mockPrices = { price0: 1, price1: 1 };
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.5,
      upperPrice: 1.5,
    });
    const patches = [];
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
      _lastUnclaimedFeesUsd: 4.25,
      _lastUnclaimedFee0: 1.25,
      _lastUnclaimedFee1: 3,
      _botState: { compoundedAmount0: 10, compoundedAmount1: 20 },
      updateBotState: (p) => patches.push(p),
    };
    const result = {
      token0UsdPrice: 1,
      token1UsdPrice: 1,
      exitValueUsd: 100,
      amount0Minted: 0n,
      amount1Minted: 0n,
      currentPrice: 1,
      newTickLower: -100,
      newTickUpper: 100,
    };
    await _closePnlEpoch(deps, result);
    const compPatch = patches.find((p) => "compoundedAmount0" in p);
    assert.ok(compPatch, "should emit a compounded-coins patch");
    assert.strictEqual(compPatch.compoundedAmount0, 11.25);
    assert.strictEqual(compPatch.compoundedAmount1, 23);
    assert.strictEqual(deps._lastUnclaimedFeesUsd, 0);
  });

  it("does not bump the compounded coins when no unclaimed fees", async () => {
    _mockGasCost = 0;
    _mockPrices = { price0: 1, price1: 1 };
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.5,
      upperPrice: 1.5,
    });
    const patches = [];
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
      _lastUnclaimedFeesUsd: 0,
      _lastUnclaimedFee0: 0,
      _lastUnclaimedFee1: 0,
      _botState: { compoundedAmount0: 10, compoundedAmount1: 20 },
      updateBotState: (p) => patches.push(p),
    };
    const result = {
      token0UsdPrice: 1,
      token1UsdPrice: 1,
      exitValueUsd: 100,
      amount0Minted: 0n,
      amount1Minted: 0n,
      currentPrice: 1,
      newTickLower: -100,
      newTickUpper: 100,
    };
    await _closePnlEpoch(deps, result);
    const compPatch = patches.find((p) => "compoundedAmount0" in p);
    assert.strictEqual(
      compPatch,
      undefined,
      "should not emit a compounded-coins patch",
    );
  });

  it("handles error gracefully", async () => {
    _mockPrices = { price0: 1, price1: 1 };
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.5,
      upperPrice: 1.5,
    });
    // closeEpoch will throw because result has no valid data
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          toFloat: () => {
            throw new Error("parse error");
          },
          fetchTokenPrices: async () => _mockPrices,
          estimateGasCostUsd: async () => 0,
          actualGasCostUsd: async () => 0,
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-recorder")];
    const { _closePnlEpoch: fn } = require("../src/bot-recorder");
    const deps = {
      _pnlTracker: tracker,
      position: { token0: "0xA", token1: "0xB" },
    };
    // Should not throw — error is caught internally
    await fn(deps, { token0UsdPrice: 1, token1UsdPrice: 1 });
  });
});
