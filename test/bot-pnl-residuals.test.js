/**
 * @file test/bot-pnl-residuals.test.js
 * @description Behaviour test for wallet-residual handling in
 * `overridePnlWithRealValues`.  Per the user-reported "Wallet Residual
 * is not included in overall profit-loss" omission, residuals ARE now
 * credited to the LP-side of the HODL IL comparison (gross credit:
 * `IL = (lpValue + residualValueUsd) − hodlValue`).
 *
 * Accepted edge case per the user's "simple a vs b" mandate: a freshly
 * minted LP that has not yet rebalanced will show +$X of IL/G equal to
 * its initial-mint leftover residual until the first rebalance folds
 * that leftover into the position.  We do not subtract the initial-
 * mint residual to avoid that ghost — the user explicitly chose the
 * simple credit over full LP-accounting symmetry.
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

describe("bot-pnl-updater: residuals credit the LP-side of IL", () => {
  const pos = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
  const pool = { tick: 0, decimals0: 18, decimals1: 18 };

  it("lifetimeIL and totalIL increase by residualValueUsd; currentValue stays LP-only", async () => {
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
      "residuals must still be surfaced separately on the snap",
    );
    /*- IL goes UP by exactly the residual USD value — the LP-side now
     *  carries credit for the coins it has given back to the wallet. */
    assert.ok(
      Math.abs(snap1.lifetimeIL - snap0.lifetimeIL - 63.41) < 1e-6,
      `lifetimeIL must rise by residualValueUsd ($63.41); ` +
        `snap0=${snap0.lifetimeIL} snap1=${snap1.lifetimeIL}`,
    );
    assert.ok(
      Math.abs(snap1.totalIL - snap0.totalIL - 63.41) < 1e-6,
      `totalIL must rise by residualValueUsd ($63.41); ` +
        `snap0=${snap0.totalIL} snap1=${snap1.totalIL}`,
    );
    /*- currentValue stays LP-only — the residual is its own line item
     *  on the dashboard's Lifetime panel; we don't fold it into
     *  currentValue (only into IL). */
    assert.strictEqual(
      snap1.currentValue,
      snap0.currentValue,
      "currentValue must be LP-only (no residuals folded in)",
    );
  });

  it("residualValueUsd is exposed on snap.ilInputs for the IL/G modal", async () => {
    const baseline = {
      entryValue: 500,
      hodlAmount0: 25,
      hodlAmount1: 125,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    const snap = {
      liveEpoch: { entryValue: 500 },
      closedEpochs: [{ hodlAmount0: 25, hodlAmount1: 125 }],
      initialDeposit: 500,
      totalGas: 0,
    };
    await overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0, {
      usd: 9.85,
      usd0: 5,
      usd1: 4.85,
      amount0: 0.5,
      amount1: 2.425,
    });
    assert.strictEqual(
      snap.ilInputs?.residualValueUsd,
      9.85,
      "ilInputs must expose residualValueUsd for the dashboard modal",
    );
  });
});
