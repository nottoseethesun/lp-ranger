"use strict";

/**
 * @file test/compute-desired-edges.test.js
 * @description Two edges of `computeDesiredAmounts`, the ratio math that
 *   decides whether a rebalance or compound swaps at all, and how much.
 *
 *   Both end in "no swap", for different reasons. Balances too small to
 *   form any liquidity at the current price leave the SDK with nothing to
 *   aim for. And with no price (zero), the fallback 50/50 split values
 *   both sides at nothing, so there is no imbalance to correct.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { computeDesiredAmounts } = require("../src/lib/rebalancer-swap");

const NO_SWAP = {
  needsSwap: false,
  swapDirection: null,
  swapAmount: 0n,
};

describe("computeDesiredAmounts — edges that end in no swap", () => {
  it("does not swap balances too small to form liquidity in range", () => {
    /*-
     *  At tick 100000 one wei of token1 is worth far less than one unit
     *  of liquidity across [99000, 101000], so the SDK needs nothing of
     *  either side — and both sides hold something, so the single-sided
     *  fallback does not apply either.
     */
    const out = computeDesiredAmounts(
      { amount0: 1n, amount1: 1n },
      {
        currentPrice: 1.0001 ** 100000,
        currentTick: 100000,
        lowerTick: 99000,
        upperTick: 101000,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.deepEqual(
      {
        needsSwap: out.needsSwap,
        swapDirection: out.swapDirection,
        swapAmount: out.swapAmount,
      },
      NO_SWAP,
    );
  });

  it("does not swap when there is no price to value the sides by", () => {
    /*-
     *  No tick range, so the 50/50 split decides; at a price of zero the
     *  token0 side is worth nothing and the total is zero.
     */
    const out = computeDesiredAmounts(
      { amount0: 5n * 10n ** 18n, amount1: 0n },
      { currentPrice: 0 },
      { decimals0: 18, decimals1: 18 },
    );
    assert.deepEqual(out, {
      amount0Desired: 0n,
      amount1Desired: 0n,
      ...NO_SWAP,
    });
  });
});
