/**
 * @file test/compound-figures-at-creation.test.js
 * @description The figure a Compound entry in the Activity Log keeps from
 * the moment the bot made the compound (`compoundFiguresAtCreation`,
 * src/compound-activity-figures.js): the fee coins it collected, and
 * their share of the position right after it. Split from
 * test/compound-activity-figures.test.js at the 500-line cap; that file
 * covers the figures a rebuild works out from the chain and what it keeps.
 *
 * The fixture compound: fees of 10 of token0 and 20 of token1, worth $40
 * at $2 and $1, and a deposit worth $32 that added liquidity 100 to make
 * 1,000 in all. The deposit is a tenth of the position after it, so the
 * position was worth $320, and the fees 12.5% of it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  compoundFiguresAtCreation,
} = require("../src/compound-activity-figures");

const close = (a, b) => Math.abs(a - b) < 1e-9;

describe("compoundFiguresAtCreation", () => {
  const RESULT = Object.freeze({
    feesCollected: { amount0: 10, amount1: 20 },
    collectedUsd: 40,
    usdValue: 32,
    price0: 2,
    price1: 1,
    liquidity: "100",
  });

  it("is the fees' share of the position right after the compound", () => {
    const got = compoundFiguresAtCreation(RESULT, { liquidity: "900" });
    assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
    assert.ok(close(got.historical.percentGainForPosition, 12.5));
  });

  it("keeps its precision for liquidity past what a number holds", () => {
    const big = { ...RESULT, liquidity: "1" + "0".repeat(30) };
    const got = compoundFiguresAtCreation(big, {
      liquidity: "9" + "0".repeat(30),
    });
    assert.ok(close(got.historical.percentGainForPosition, 12.5));
  });

  it("records a null figure, and never throws, on anything it cannot use", () => {
    const cases = [
      [null, undefined],
      [RESULT, undefined],
      [RESULT, { liquidity: "not a number" }],
      [{ ...RESULT, liquidity: "0" }, { liquidity: "900" }],
      [{ ...RESULT, usdValue: 0 }, { liquidity: "900" }],
      [{ ...RESULT, collectedUsd: Number.NaN }, { liquidity: "900" }],
    ];
    for (const [result, position] of cases) {
      const got = compoundFiguresAtCreation(result, position);
      assert.equal(got.historical.percentGainForPosition, null);
    }
  });

  it("is unknown when either coin has no price, rather than a figure from one coin", () => {
    /*-
     *  With token0 unpriced, the compound valued only token1: $20 of fees
     *  and $16 of deposit. A share worked out from those counts one coin
     *  of two on both sides, so it is left unknown, as a Rebalance's
     *  figure is without both prices.
     */
    const oneCoin = { ...RESULT, collectedUsd: 20, usdValue: 16, price0: 0 };
    for (const result of [oneCoin, { ...RESULT, price1: undefined }]) {
      const got = compoundFiguresAtCreation(result, { liquidity: "900" });
      assert.equal(got.historical.percentGainForPosition, null);
      assert.deepEqual(got.feesCollected, { amount0: 10, amount1: 20 });
    }
  });

  it("keeps no fee coins that are not a coin pair", () => {
    const got = compoundFiguresAtCreation(
      { ...RESULT, feesCollected: { amount0: -1, amount1: 2 } },
      { liquidity: "900" },
    );
    assert.equal(got.feesCollected, null);
  });
});
