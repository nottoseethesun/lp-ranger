/**
 * @file test/coin-value.test.js
 * @description The one place coins become dollars.
 *
 *   Every current total in the app is the saved coins multiplied by the
 *   current price, and this is where that multiplication happens — so a
 *   fault here is wrong money on every panel at once, in a direction
 *   nothing downstream can detect.
 *
 *   The fixtures are deliberately asymmetric: the two tokens have
 *   different amounts AND different prices, so a function that confuses
 *   token0 with token1, or drops one side, cannot produce the right
 *   answer by coincidence.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { coinsToUsd, nftCoinsToUsd } = require("../src/coin-value");

/*- 4 of token0 at $3 is 12; 5 of token1 at $7 is 35; total 47. Every
 *  number distinct, so no swap or omission lands on 47 by accident. */
const COINS = { amount0: 4, amount1: 5 };
const P0 = 3;
const P1 = 7;
const TOTAL = 47;

describe("coinsToUsd", () => {
  it("values both sides at their own price", () => {
    assert.equal(coinsToUsd(COINS, P0, P1), TOTAL);
  });

  it("does not confuse the two tokens", () => {
    /*- Swapping the prices must change the answer; with equal prices or
     *  equal amounts it could not. */
    assert.notEqual(coinsToUsd(COINS, P1, P0), TOTAL);
  });

  it("counts a side that is present but zero", () => {
    assert.equal(coinsToUsd({ amount0: 4, amount1: 0 }, P0, P1), 12);
  });

  it("treats a missing pair or side as nothing", () => {
    for (const a of [null, undefined, {}, { amount0: undefined }])
      assert.equal(coinsToUsd(a, P0, P1), 0, JSON.stringify(a));
    assert.equal(coinsToUsd({ amount1: 5 }, P0, P1), 35);
  });

  it("answers zero, not NaN, when a price is missing", () => {
    for (const p of [0, null, undefined]) {
      const v = coinsToUsd(COINS, p, p);
      assert.ok(!Number.isNaN(v), "price " + String(p) + " gave NaN");
      assert.equal(v, 0);
    }
  });

  it("scales with the price", () => {
    assert.equal(coinsToUsd(COINS, P0 * 2, P1 * 2), TOTAL * 2);
  });

  it("carries a negative amount through rather than clamping", () => {
    /*- A negative coin count means an upstream figure is wrong. Showing
     *  it is how that gets noticed; clamping would hide it. */
    assert.equal(coinsToUsd({ amount0: -4, amount1: 0 }, P0, P1), -12);
  });

  it("stays finite on amounts and prices at realistic extremes", () => {
    const v = coinsToUsd({ amount0: 1e18, amount1: 1e18 }, 1e-9, 1e-9);
    assert.ok(Number.isFinite(v), "got " + v);
  });
});

describe("nftCoinsToUsd", () => {
  const MAP = { 300: COINS, 400: { amount0: 1, amount1: 1 } };

  it("values the named NFT, not another", () => {
    assert.equal(nftCoinsToUsd(MAP, "300", P0, P1), TOTAL);
    assert.equal(nftCoinsToUsd(MAP, "400", P0, P1), P0 + P1);
  });

  it("resolves a string, a number and a BigInt tokenId alike", () => {
    /*- `position.tokenId` arrives as all three across the callers: a
     *  string from config, a number from the position store, a BigInt
     *  from a chain read. A lookup that skipped the conversion would
     *  answer zero for two of them — a figure silently absent, not an
     *  error. */
    for (const id of ["300", 300, 300n])
      assert.equal(
        nftCoinsToUsd(MAP, id, P0, P1),
        TOTAL,
        "tokenId as " + typeof id,
      );
  });

  it("answers zero for an NFT the map does not name", () => {
    assert.equal(nftCoinsToUsd(MAP, "999", P0, P1), 0);
  });

  it("answers zero for a missing map", () => {
    for (const m of [null, undefined, {}])
      assert.equal(nftCoinsToUsd(m, "300", P0, P1), 0);
  });

  it("does not read through to Object.prototype", () => {
    /*- tokenIds come from chain events, so this is not reachable — but
     *  a lookup that answered something for `__proto__` would be
     *  answering about the wrong object entirely. */
    assert.equal(nftCoinsToUsd(MAP, "__proto__", P0, P1), 0);
    assert.equal(nftCoinsToUsd(MAP, "constructor", P0, P1), 0);
  });
});
