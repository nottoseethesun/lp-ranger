/**
 * @file test/bot-deposit.test.js
 * @description Tests for `totalLifetimeDeposit`'s belt-and-suspenders guard:
 *   a deposit whose token amounts compute non-finite (undefined/NaN decimals
 *   → `10 ** undefined === NaN`) is skipped rather than poisoning the running
 *   total. With valid decimals the total is computed normally.
 * Run with: npm test
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { totalLifetimeDeposit } = require("../src/bot-deposit");

/*- One deposit: 1.0 token0 and 2.0 token1 (18 decimals each), fresh per call
 *  because `totalLifetimeDeposit` memoizes computed USD onto each entry. */
function oneDeposit() {
  return [
    { raw0: "1000000000000000000", raw1: "2000000000000000000", block: 100 },
  ];
}
const prices = async () => ({ price0: 2, price1: 3 });

describe("totalLifetimeDeposit NaN guard", () => {
  it("skips a deposit with undefined decimals instead of NaN-poisoning the total", async () => {
    const res = await totalLifetimeDeposit(
      oneDeposit(),
      undefined,
      undefined,
      prices,
    );
    assert.equal(Number.isFinite(res.total), true);
    assert.equal(res.total, 0);
  });

  it("computes a finite total with valid decimals", async () => {
    // 1.0 token0 @ $2 + 2.0 token1 @ $3 = 8
    const res = await totalLifetimeDeposit(oneDeposit(), 18, 18, prices);
    assert.equal(res.total, 8);
  });
});

describe("totalLifetimeDeposit — re-valuing at fresh prices", () => {
  /** One deposit that already carries the figure a bad price produced. */
  const priced = () => [{ ...oneDeposit()[0], usd: 9999 }];

  it("reuses the figure a deposit already carries", async () => {
    let calls = 0;
    const counted = async () => {
      calls += 1;
      return { price0: 2, price1: 3 };
    };
    const res = await totalLifetimeDeposit(priced(), 18, 18, counted);
    assert.equal(res.total, 9999);
    assert.equal(calls, 0, "no source is asked");
  });

  it("prices every deposit again when asked to refresh", async () => {
    let calls = 0;
    const counted = async () => {
      calls += 1;
      return { price0: 2, price1: 3 };
    };
    const res = await totalLifetimeDeposit(priced(), 18, 18, counted, {
      refresh: true,
    });
    assert.equal(calls, 1, "the source is asked again");
    assert.equal(res.total, 8, "the new price replaces the old figure");
  });

  it("keeps the old figure when the refresh finds no price", async () => {
    /*- Zero means no source answered. Replacing a real figure with it
     *  would make Re-scan Prices destructive on a bad feed day. */
    const empty = async () => ({ price0: 0, price1: 0 });
    const res = await totalLifetimeDeposit(priced(), 18, 18, empty, {
      refresh: true,
    });
    assert.equal(res.total, 9999);
  });
});
