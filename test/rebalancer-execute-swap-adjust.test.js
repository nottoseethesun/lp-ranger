"use strict";

/**
 * @file test/rebalancer-execute-swap-adjust.test.js
 * @description What a rebalance does when its own swap moves the price.
 *
 *   A rebalance computes the new range from the pool's tick, then swaps in
 *   that same pool — and a swap moves the tick. If the tick leaves the
 *   range, the mint would accept only one coin. Step 6b shifts the range,
 *   width unchanged, to contain the tick again. Step 6c re-reads the tick
 *   right before minting and backs off if the price is still running. And
 *   when corrective swaps run out of iterations with an imbalance left
 *   over, the rebalance result carries a warning saying so.
 *
 *   Pool state is read through the real `getPoolState` against the
 *   shared contract mocks, with the pool's tick set per test.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  _adjustRangeAfterSwap,
  _preMintTickCheck,
  _buildRebalanceResult,
  _walletBalances,
  _computeRange,
} = require("../src/lib/rebalancer-execute");
const {
  ADDR,
  Q96,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

// Fee 3000 → tick spacing 60 in the mocks' factory.
const POSITION = { token0: ADDR.token0, token1: ADDR.token1, fee: 3000 };

/** Contract mocks whose pool reports the given tick after the swap. */
function libAtTick(tick) {
  const d = defaultDispatch();
  d[ADDR.pool] = {
    ...d[ADDR.pool],
    slot0: async () => ({ sqrtPriceX96: Q96, tick: BigInt(tick) }),
  };
  return buildMockEthersLib({ contractDispatch: d });
}

const POOL_BEFORE = { tick: 0 };

describe("Step 6b — shifting the range after the swap moved the tick", () => {
  it("shifts down to contain a tick that fell below the range", async () => {
    const range = { lowerTick: 600, upperTick: 1200 };
    await _adjustRangeAfterSwap(
      libAtTick(-130),
      POSITION,
      ADDR.factory,
      POOL_BEFORE,
      range,
      50,
    );
    // floor(-130 / 60) × 60 = -180; width 600 kept.
    assert.deepEqual(range, { lowerTick: -180, upperTick: 420 });
  });

  it("shifts up to contain a tick that rose above the range", async () => {
    const range = { lowerTick: -1200, upperTick: -600 };
    await _adjustRangeAfterSwap(
      libAtTick(130),
      POSITION,
      ADDR.factory,
      POOL_BEFORE,
      range,
      undefined,
    );
    // (floor(130 / 60) + 1) × 60 = 180; width 600 kept.
    assert.deepEqual(range, { lowerTick: -420, upperTick: 180 });
  });

  it("leaves a range that still contains the tick alone", async () => {
    const range = { lowerTick: -600, upperTick: 600 };
    await _adjustRangeAfterSwap(
      libAtTick(130),
      POSITION,
      ADDR.factory,
      POOL_BEFORE,
      range,
      50,
    );
    assert.deepEqual(range, { lowerTick: -600, upperTick: 600 });
  });

  it("keeps an offset range off-centre on purpose", async () => {
    // With an offset, the tick may be outside the range by design.
    const range = { lowerTick: 600, upperTick: 1200 };
    await _adjustRangeAfterSwap(
      libAtTick(-130),
      POSITION,
      ADDR.factory,
      POOL_BEFORE,
      range,
      30,
    );
    assert.deepEqual(range, { lowerTick: 600, upperTick: 1200 });
  });
});

describe("Step 6c — backing off when the price keeps moving", () => {
  it("refuses to mint while the tick is still outside the range", async () => {
    const out = await _preMintTickCheck(
      libAtTick(-130),
      POSITION,
      ADDR.factory,
      { lowerTick: 600, upperTick: 1200 },
      50,
    );
    assert.deepEqual(out, {
      success: false,
      priceVolatile: true,
      error: "Price moved during rebalance — backing off",
    });
  });

  it("lets the mint go ahead when the tick is inside", async () => {
    const out = await _preMintTickCheck(
      libAtTick(130),
      POSITION,
      ADDR.factory,
      { lowerTick: -600, upperTick: 600 },
      50,
    );
    assert.equal(out, null);
  });

  it("does not check an offset range at all", async () => {
    const out = await _preMintTickCheck(
      libAtTick(-130),
      POSITION,
      ADDR.factory,
      { lowerTick: 600, upperTick: 1200 },
      30,
    );
    assert.equal(out, null);
  });
});

describe("rebalance result — corrective swaps that ran out of iterations", () => {
  const removed = { amount0: 10n, amount1: 20n, gasCostWei: 5n };
  const mint = {
    tokenId: 9n,
    liquidity: 77n,
    amount0: 9n,
    amount1: 19n,
    gasCostWei: 7n,
  };
  const build = (corrective) =>
    _buildRebalanceResult(
      ["0xa"],
      removed,
      { gasCostWei: 3n, swapSources: "Watergun Aggregator" },
      mint,
      { ...POSITION, tokenId: 8n, tickLower: -60, tickUpper: 60 },
      { lowerTick: -120, upperTick: 120 },
      { price: 1.0, poolAddress: ADDR.pool, decimals0: 18, decimals1: 18 },
      undefined,
      corrective,
      { chain: "pulsechain", contract: ADDR.pm, wallet: ADDR.signer },
    );

  it("warns with the iterations, the imbalance left and the threshold", () => {
    const r = build({
      aboveThresholdAfterCap: true,
      iterations: 3,
      finalImbalanceUsd: 4.2,
      thresholdUsd: 1,
      gasCostWei: 11n,
      swapSources: ["Watergun Aggregator"],
    });
    assert.deepEqual(r.residualWarning, {
      iterations: 3,
      imbalanceUsd: 4.2,
      thresholdUsd: 1,
    });
    // Every step's gas, the corrective swaps' included.
    assert.equal(r.totalGasCostWei, 5n + 3n + 7n + 11n);
    assert.equal(r.swapSources, "Watergun Aggregator");
  });

  it("carries no warning when the corrective swaps finished the job", () => {
    const r = build({ aboveThresholdAfterCap: false, iterations: 1 });
    assert.ok(!("residualWarning" in r));
  });

  it("reports the width asked for beside the width it got, with no corrective step", () => {
    // Asked for 10%; the ticks landed 1.9 to 2.15 at a price of 2, 12.5% wide.
    const r = _buildRebalanceResult(
      ["0xa"],
      removed,
      { gasCostWei: 3n },
      mint,
      { ...POSITION, tokenId: 8n, tickLower: -60, tickUpper: 60 },
      { lowerTick: 6420, upperTick: 7680, lowerPrice: 1.9, upperPrice: 2.15 },
      { price: 2.0, poolAddress: ADDR.pool, decimals0: 18, decimals1: 18 },
      10,
      undefined,
      { chain: "pulsechain", contract: ADDR.pm, wallet: ADDR.signer },
    );
    assert.equal(r.requestedRangePct, 10);
    assert.equal(r.effectiveRangePct, 12.5);
    // Removal, swap and mint only: there was no corrective step.
    assert.equal(r.totalGasCostWei, 5n + 3n + 7n);
    assert.ok(!("residualWarning" in r));
  });
});

describe("recovery — a position already drained", () => {
  it("refuses to go on when the wallet holds neither coin", async () => {
    // The shared mocks report empty balances until a collect.
    await assert.rejects(
      _walletBalances(
        buildMockEthersLib({ contractDispatch: defaultDispatch() }),
        {},
        ADDR.token0,
        ADDR.token1,
        ADDR.signer,
      ),
      /Position drained and wallet has 0 balance of both tokens/,
    );
  });

  it("carries on with whatever the wallet holds", async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => 5n };
    const r = await _walletBalances(
      buildMockEthersLib({ contractDispatch: d }),
      {},
      ADDR.token0,
      ADDR.token1,
      ADDR.signer,
    );
    /*-
     *  Nothing is drained, so the wallet before the drain is this same
     *  reading, for the Activity Log figures.
     */
    assert.deepEqual(r, {
      amount0: 5n,
      amount1: 0n,
      txHash: null,
      walletBefore: { amount0: 5n, amount1: 0n },
    });
  });
});

describe("rebalance result — the wallet's three readings", () => {
  const E18 = 10n ** 18n;
  const mint = {
    tokenId: 9n,
    liquidity: 77n,
    amount0: 9n,
    amount1: 19n,
    gasCostWei: 7n,
  };
  const build = (removed, readings) =>
    _buildRebalanceResult(
      ["0xa"],
      removed,
      { gasCostWei: 3n },
      mint,
      { ...POSITION, tokenId: 8n, tickLower: -60, tickUpper: 60 },
      { lowerTick: -120, upperTick: 120 },
      { price: 1.0, poolAddress: ADDR.pool, decimals0: 18, decimals1: 6 },
      undefined,
      undefined,
      { chain: "pulsechain", contract: ADDR.pm, wallet: ADDR.signer },
      readings,
    );

  it("keeps them in whole coins: before the drain, after it, and before the mint", () => {
    const r = build(
      {
        amount0: 10n * E18,
        amount1: 0n,
        gasCostWei: 5n,
        walletBefore: { amount0: E18, amount1: 2_000_000n },
      },
      {
        afterDrain: { amount0: 11n * E18, amount1: 2_000_000n },
        beforeMint: { amount0: 6n * E18, amount1: 7_500_000n },
      },
    );
    assert.deepEqual(r.walletReadings, {
      beforeDrain: { amount0: 1, amount1: 2 },
      afterDrain: { amount0: 11, amount1: 2 },
      beforeMint: { amount0: 6, amount1: 7.5 },
    });
  });

  it("leaves a reading the rebalance did not hand on unknown", () => {
    const r = build({ amount0: 1n, amount1: 1n, gasCostWei: 5n }, undefined);
    assert.deepEqual(r.walletReadings, {
      beforeDrain: null,
      afterDrain: null,
      beforeMint: null,
    });
  });
});

describe("new range — the existing width, with no offset given", () => {
  it("re-centres the old width on the current tick", () => {
    /*-
     *  No offset means the shipped one applies inside range-math. The
     *  tick has left the old range, as it has when a rebalance is due,
     *  so the old ticks do not pass for the new ones.
     */
    const r = _computeRange(
      { tick: 2000, tickSpacing: 60, decimals0: 18, decimals1: 18, price: 1 },
      { tickLower: -600, tickUpper: 600, tokenId: 1n },
      undefined,
      undefined,
      false,
    );
    assert.equal(r.upperTick - r.lowerTick, 1200);
    assert.ok(r.lowerTick <= 2000 && 2000 < r.upperTick, JSON.stringify(r));
  });
});
