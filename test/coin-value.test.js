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

const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  coinsToUsd,
  nftCoinsToUsd,
  coinsFromUnits,
  rebalanceIlPct,
  shareOfValuePct,
} = require("../src/lib/coin-value");

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

describe("coinsFromUnits", () => {
  it("divides each side by its own decimals", () => {
    /*-
     *  18 decimals on one side and 6 on the other, so a function that
     *  used one scale for both, or swapped them, cannot land on 1.5 and
     *  2.25 by accident.
     */
    const want = { amount0: 1.5, amount1: 2.25 };
    assert.deepEqual(coinsFromUnits(15n * 10n ** 17n, 2250000n, 18, 6), want);
    assert.deepEqual(
      coinsFromUnits("1500000000000000000", "2250000", 18, 6),
      want,
    );
    assert.deepEqual(coinsFromUnits(1500, 2250000, 3, 6), want);
  });

  it("answers zero coins for zero units", () => {
    assert.deepEqual(coinsFromUnits(0n, "0", 18, 6), {
      amount0: 0,
      amount1: 0,
    });
  });

  it("answers null for an amount that is not a whole amount of at least zero", () => {
    for (const bad of [-1n, "-1", "1.5", "abc", "", 1.5, -1, null, undefined]) {
      assert.equal(coinsFromUnits(bad, 1n, 18, 18), null, String(bad));
      assert.equal(coinsFromUnits(1n, bad, 18, 18), null, String(bad));
    }
  });

  it("answers null for decimals no token can have", () => {
    for (const bad of [-1, 1.5, 256, "18", null, undefined, NaN]) {
      assert.equal(coinsFromUnits(1n, 1n, bad, 18), null, String(bad));
      assert.equal(coinsFromUnits(1n, 1n, 18, bad), null, String(bad));
    }
  });
});

describe("rebalanceIlPct", () => {
  /*-
   *  Before: 10 of token0 at $2, worth $20. After the swaps: 5 of token0
   *  and 1.9 of token1 at $5, worth $10 + $9.50 = $19.50. The swaps lost
   *  $0.50, which is -0.50 / 19.50 of the position after.
   */
  const BEFORE = { amount0: 10, amount1: 0 };
  const AFTER = { amount0: 5, amount1: 1.9 };

  it("is the change in value as a percent of the basket after", () => {
    const pct = rebalanceIlPct(BEFORE, AFTER, 2, 5);
    assert.ok(Math.abs(pct - (-0.5 / 19.5) * 100) < 1e-9, String(pct));
  });

  it("turns to a gain when the coins bought rise against the coins sold", () => {
    // At $6 for token1 the basket after is worth $21.40 against $20.
    const pct = rebalanceIlPct(BEFORE, AFTER, 2, 6);
    assert.ok(Math.abs(pct - (1.4 / 21.4) * 100) < 1e-9, String(pct));
  });

  it("is zero when the two baskets are the same coins", () => {
    assert.equal(rebalanceIlPct(AFTER, AFTER, 2, 5), 0);
  });

  it("does not confuse the two tokens", () => {
    assert.notEqual(
      rebalanceIlPct(BEFORE, AFTER, 5, 2),
      rebalanceIlPct(BEFORE, AFTER, 2, 5),
    );
  });

  it("answers null when either price is missing or not above zero", () => {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, "2"]) {
      assert.equal(rebalanceIlPct(BEFORE, AFTER, bad, 5), null, String(bad));
      assert.equal(rebalanceIlPct(BEFORE, AFTER, 2, bad), null, String(bad));
    }
  });

  it("answers null for a malformed basket", () => {
    const bads = [
      null,
      undefined,
      {},
      { amount0: 1 },
      { amount0: -1, amount1: 1 },
      { amount0: NaN, amount1: 1 },
      { amount0: "1", amount1: 1 },
    ];
    for (const bad of bads) {
      assert.equal(rebalanceIlPct(bad, AFTER, 2, 5), null, JSON.stringify(bad));
      assert.equal(
        rebalanceIlPct(BEFORE, bad, 2, 5),
        null,
        JSON.stringify(bad),
      );
    }
  });

  it("answers null when the basket after is worth nothing", () => {
    const empty = { amount0: 0, amount1: 0 };
    assert.equal(rebalanceIlPct(BEFORE, empty, 2, 5), null);
  });
});

describe("shareOfValuePct", () => {
  it("is the coins' value as a percent of the total", () => {
    // The $47 pair against a $470 position is 10%.
    assert.equal(shareOfValuePct(COINS, P0, P1, TOTAL * 10), 10);
  });

  it("answers null when a price is missing or not above zero", () => {
    for (const bad of [0, -1, NaN, null, undefined]) {
      assert.equal(shareOfValuePct(COINS, bad, P1, 470), null, String(bad));
      assert.equal(shareOfValuePct(COINS, P0, bad, 470), null, String(bad));
    }
  });

  it("answers null for malformed coins", () => {
    for (const bad of [null, undefined, {}, { amount0: -1, amount1: 1 }])
      assert.equal(
        shareOfValuePct(bad, P0, P1, 470),
        null,
        JSON.stringify(bad),
      );
  });

  it("answers null when the total is not a number above zero", () => {
    for (const bad of [0, -470, NaN, Infinity, null, undefined, "470"])
      assert.equal(shareOfValuePct(COINS, P0, P1, bad), null, String(bad));
  });
});

describe("the module stays importable from the browser bundle", () => {
  it("imports nothing", () => {
    /*-
     *  The dashboard bundle imports this file to work out each Activity
     *  Log entry's Current figure, so a single `require` of anything
     *  Node-only would break the build — and the failure would show as a
     *  broken dashboard, not a failing test.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "coin-value.js"),
      "utf8",
    );
    assert.deepEqual(src.match(/\brequire\s*\(/g) || [], []);
    assert.deepEqual(src.match(/^\s*import\s/gm) || [], []);
  });
});
