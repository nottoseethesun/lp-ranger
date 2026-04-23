/**
 * @file test/bot-pnl-residuals.test.js
 * @description Regression tests for wallet-residual handling in
 * `overridePnlWithRealValues`. Residuals (tokens left in the wallet after
 * a mint or rebalance) must NOT be folded into `lifetimeIL`, `totalIL`, or
 * `currentValue`. They are surfaced separately via `residualValueUsd` and
 * roll into the lifetime deposit on the next rebalance.
 *
 * Before the fix, a fresh LP with ~$63 of 9mm-dApp-residual tokens produced
 * a bogus +$63 Lifetime IL/G because `lifetimeIL` computed
 * `(realValue + residualUsd) − hodlValue`.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
const { _resetForTest } = require("../src/gecko-rate-limit");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

describe("bot-pnl-updater: residuals do not affect IL or currentValue", () => {
  const pos = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
  const pool = { tick: 0, decimals0: 18, decimals1: 18 };

  it("lifetimeIL, totalIL and currentValue ignore residualValueUsd", async () => {
    const baseline = {
      entryValue: 500,
      hodlAmount0: 25,
      hodlAmount1: 125,
      token0UsdPrice: 10,
      token1UsdPrice: 2,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    const mkSnap = () => ({
      liveEpoch: { entryValue: 500 },
      closedEpochs: [{ hodlAmount0: 25, hodlAmount1: 125 }],
      initialDeposit: 500,
      totalGas: 0,
    });
    const snap0 = mkSnap();
    const snap1 = mkSnap();
    await overridePnlWithRealValues(snap0, deps, pos, pool, 10, 2, 0, null);
    await overridePnlWithRealValues(snap1, deps, pos, pool, 10, 2, 0, {
      usd: 63.41,
      usd0: 40,
      usd1: 23.41,
      amount0: 4,
      amount1: 11.705,
    });
    assert.strictEqual(
      snap1.residualValueUsd,
      63.41,
      "residuals should be surfaced separately",
    );
    assert.strictEqual(
      snap1.lifetimeIL,
      snap0.lifetimeIL,
      "lifetimeIL must not change when residuals are present",
    );
    assert.strictEqual(
      snap1.totalIL,
      snap0.totalIL,
      "totalIL must not change when residuals are present",
    );
    assert.strictEqual(
      snap1.currentValue,
      snap0.currentValue,
      "currentValue must be LP-only (no residuals folded in)",
    );
  });
});
