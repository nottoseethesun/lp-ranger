/**
 * @file test/il-calculator-hodl.test.js
 * @description Unit tests for `computeHodlIL` in src/il-calculator.js,
 * including the residual-credit fix that closed the user-reported
 * "Wallet Residual is not included in overall profit-loss" omission.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeHodlIL } = require("../src/il-calculator");

describe("computeHodlIL — base behaviour", () => {
  it("returns lpValue − hodlValue when residual is not supplied", () => {
    const il = computeHodlIL({
      lpValue: 1000,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
    });
    assert.equal(il, 1000 - (100 * 5 + 100 * 5));
  });

  it("returns null when both hodl amounts are nullish", () => {
    assert.equal(
      computeHodlIL({
        lpValue: 100,
        hodlAmount0: null,
        hodlAmount1: undefined,
        currentPrice0: 1,
        currentPrice1: 1,
      }),
      null,
    );
  });

  it("returns null when both prices are non-positive", () => {
    assert.equal(
      computeHodlIL({
        lpValue: 100,
        hodlAmount0: 10,
        hodlAmount1: 10,
        currentPrice0: 0,
        currentPrice1: 0,
      }),
      null,
    );
  });

  it("positive IL = gain vs holding (LP outperformed)", () => {
    const il = computeHodlIL({
      lpValue: 1100,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
    });
    assert.equal(il, 100);
  });

  it("negative IL = loss vs holding", () => {
    const il = computeHodlIL({
      lpValue: 900,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
    });
    assert.equal(il, -100);
  });
});

describe("computeHodlIL — residual credit (Wallet Residual fix)", () => {
  /*- Regression test: per the user-reported issue, "Wallet Residual is
   *  not included in overall profit-loss - an oversight from our
   *  earlier work that is not visible with the bigger tokens since
   *  those swaps are always easy to do."  The fix credits the
   *  pool-scoped wallet residual to the LP-side of the HODL
   *  comparison.  Initial-mint residual is deliberately NOT mixed in
   *  here — see computeHodlIL JSDoc. */

  it("credits residualValueUsd to the LP-side", () => {
    const ilWithoutResidual = computeHodlIL({
      lpValue: 1000,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
    });
    const ilWithResidual = computeHodlIL({
      lpValue: 1000,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
      residualValueUsd: 50,
    });
    assert.equal(ilWithResidual - ilWithoutResidual, 50);
  });

  it("treats undefined / null / 0 residual as zero contribution", () => {
    const baseline = computeHodlIL({
      lpValue: 800,
      hodlAmount0: 100,
      hodlAmount1: 100,
      currentPrice0: 5,
      currentPrice1: 5,
    });
    for (const r of [undefined, null, 0]) {
      const il = computeHodlIL({
        lpValue: 800,
        hodlAmount0: 100,
        hodlAmount1: 100,
        currentPrice0: 5,
        currentPrice1: 5,
        residualValueUsd: r,
      });
      assert.equal(il, baseline, `residualValueUsd=${r} must match baseline`);
    }
  });

  it("turns a small loss into a smaller loss (real-world scenario)", () => {
    /*- Numbers from the user's screenshot:
     *  LP=$297.91, HODL=$362.37 → current IL=-$64.46
     *  Adding $9.85 wallet residual: new IL=-$54.61 */
    const il = computeHodlIL({
      lpValue: 297.91,
      hodlAmount0: 79224376632.326447,
      hodlAmount1: 67136876466.296616,
      currentPrice0: 2.5655600888865592e-9,
      currentPrice1: 2.3699436609754064e-9,
      residualValueUsd: 9.85,
    });
    /*- Recompute HODL from the same inputs to compare without
     *  hard-coding the rounded $362.37 figure. */
    const hodlValue =
      79224376632.326447 * 2.5655600888865592e-9 +
      67136876466.296616 * 2.3699436609754064e-9;
    const expected = 297.91 + 9.85 - hodlValue;
    assert.ok(Math.abs(il - expected) < 1e-6, `il=${il} expected≈${expected}`);
    /*- Sanity: the residual makes IL strictly less negative than the
     *  un-credited version. */
    const ilWithoutResidual = computeHodlIL({
      lpValue: 297.91,
      hodlAmount0: 79224376632.326447,
      hodlAmount1: 67136876466.296616,
      currentPrice0: 2.5655600888865592e-9,
      currentPrice1: 2.3699436609754064e-9,
    });
    assert.ok(il > ilWithoutResidual);
    assert.ok(Math.abs(il - ilWithoutResidual - 9.85) < 1e-6);
  });

  it("does not change null-return guards when residual is supplied", () => {
    assert.equal(
      computeHodlIL({
        lpValue: 100,
        hodlAmount0: null,
        hodlAmount1: null,
        currentPrice0: 1,
        currentPrice1: 1,
        residualValueUsd: 50,
      }),
      null,
      "residual must not bypass the missing-amounts guard",
    );
  });
});
