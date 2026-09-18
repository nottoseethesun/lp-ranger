/**
 * @file test/position-value-usd.test.js
 * @description `positionValueUsd` values an LP position's two token
 *   balances at their two prices, and almost every money figure in the
 *   app is built on it: Current Value, Net P&L, Profit, IL/G, and the
 *   Impermanent Loss Guard's pre-rebalance projection.
 *
 *   Nine test files name it and every one of them replaces it with a
 *   stub, so the real function was never exercised: crossing the two
 *   prices — token0's balance valued at token1's price — passed the
 *   whole suite. These tests drive the real one.
 *
 *   The expected values come from `range-math.positionAmounts`, a
 *   different module. That matters more than it looks: deriving them by
 *   calling `positionValueUsd` itself with unit prices would make the
 *   test agree with a crossed pairing, because the derivation would be
 *   crossed the same way. The expectation has to come from outside the
 *   thing being tested.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { positionValueUsd } = require("../src/bot-pnl-updater");
const rangeMath = require("../src/range-math");

/*- An in-range position whose range is NOT centred on the current tick.
 *  That asymmetry is what makes the two balances differ; a range centred
 *  on the tick gives them identically, and a test built on that could not
 *  tell a crossed pair from a correct one.
 *
 *  Equal decimals on purpose. Unequal ones would also separate the sides,
 *  but they drive the balances orders of magnitude apart, and the
 *  differences these assertions take would lose their precision. */
const POSITION = Object.freeze({
  liquidity: "1000000000000000000",
  tickLower: -2000,
  tickUpper: 9000,
});
const POOL = Object.freeze({ tick: 0, decimals0: 18, decimals1: 18 });

/** The balances, computed independently of the function under test. */
function amounts() {
  return rangeMath.positionAmounts(
    POSITION.liquidity,
    POOL.tick,
    POSITION.tickLower,
    POSITION.tickUpper,
    POOL.decimals0,
    POOL.decimals1,
  );
}

describe("positionValueUsd", () => {
  it("has two balances that differ, so a crossed pair is detectable", () => {
    /*- The precondition every assertion below rests on. Were the two
     *  balances equal, crossing the prices would give the same answer and
     *  these tests would pass against a broken pairing — which is how the
     *  existing fixtures failed to catch it. */
    const a = amounts();
    assert.ok(a.amount0 > 0, "token0 balance must be non-zero");
    assert.ok(a.amount1 > 0, "token1 balance must be non-zero");
    assert.notEqual(
      a.amount0,
      a.amount1,
      "fixture is symmetric and cannot detect a swap",
    );
  });

  it("values each balance at its own price", () => {
    /*- Crossing the prices gives amount0 x 7 + amount1 x 3, a different
     *  number whenever the balances differ. */
    const a = amounts();
    assert.equal(
      positionValueUsd(POSITION, POOL, 3, 7),
      a.amount0 * 3 + a.amount1 * 7,
    );
  });

  it("scales with each price independently", () => {
    const a = amounts();
    assert.equal(positionValueUsd(POSITION, POOL, 1, 0), a.amount0);
    assert.equal(positionValueUsd(POSITION, POOL, 0, 1), a.amount1);
    assert.equal(
      positionValueUsd(POSITION, POOL, 6, 14),
      2 * (a.amount0 * 3 + a.amount1 * 7),
    );
  });

  it("is zero when the position holds no liquidity", () => {
    assert.equal(
      positionValueUsd({ ...POSITION, liquidity: "0" }, POOL, 3, 7),
      0,
    );
  });

  it("answers zero for a price of zero or null", () => {
    /*- Zero is how a failed price read reaches here: every failure path
     *  in `fetchTokenPriceUsd` answers zero rather than throwing, so a
     *  position whose prices could not be read is valued at zero rather
     *  than reported as broken. Null coerces the same way. */
    for (const [p0, p1] of [
      [0, 0],
      [null, null],
      [0, null],
    ]) {
      assert.equal(
        positionValueUsd(POSITION, POOL, p0, p1),
        0,
        "prices " + JSON.stringify([p0, p1]),
      );
    }
  });

  it("throws rather than returning NaN", () => {
    /*- A NaN would not stay local. This figure is Current Value, and Net
     *  P&L, Profit and IL/G are built on it, so one NaN turns every money
     *  reading into NaN at once — and compares false against every
     *  threshold it meets, including the Impermanent Loss Guard's.
     *
     *  Nothing upstream can produce it: the price fetcher answers a
     *  number and falls back to zero on every failure. So NaN means a
     *  caller passed the wrong thing, which is a defect to surface rather
     *  than a condition to absorb. */
    /*- Not covered, deliberately: a numeric string like "3". It coerces
     *  to the right number, so the figure is correct and there is nothing
     *  to alert anyone to. This guard is about a result that cannot be
     *  used, not about argument types. */
    for (const [p0, p1] of [
      [undefined, undefined],
      [undefined, 7],
      [3, undefined],
      [NaN, 7],
      [3, NaN],
    ]) {
      assert.throws(
        () => positionValueUsd(POSITION, POOL, p0, p1),
        /non-finite result/,
        "should have thrown for prices " + JSON.stringify([p0, p1]),
      );
    }
  });

  it("names the values in the error, so the defect is locatable", () => {
    /*- An error saying only "NaN" sends the reader back to the call
     *  stack to work out which input was wrong. */
    assert.throws(
      () => positionValueUsd(POSITION, POOL, undefined, 7),
      (err) => {
        assert.match(err.message, /positionValueUsd/);
        assert.match(err.message, /prices undefined\/7/);
        return true;
      },
    );
  });
});
