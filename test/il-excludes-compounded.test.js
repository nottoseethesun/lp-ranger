/**
 * @file test/il-excludes-compounded.test.js
 * @description Guards that the IL/G figures carry no fee earnings.
 *
 *   Compounding calls `increaseLiquidity`, so compounded fees become
 *   part of the liquidity `positionValueUsd` measures, while the HODL
 *   side stays fixed at the deposited amounts. Left in, a $100 compound
 *   reads as $100 of LP outperformance — and Profit adds the same $100
 *   again as fee earnings.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _computeIL } = require("../src/bot-pnl-il");

/*-
 *  Run _computeIL over a position worth `lpValue`, 100+100 deposited.
 *  `perNft` is the COINS of token0 this NFT compounded, not their value:
 *  what is saved is coins, and pricing them is the function's job.
 */
function run({ lpValue, compounded = 0, perNft = 0, price = 1 }) {
  const snap = { residualValueUsd: 0, totalCompoundedUsd: compounded };
  const deps = {
    _botState: {
      hodlBaseline: { hodlAmount0: 100, hodlAmount1: 100 },
      lifetimeHodlAmounts: { amount0: 100, amount1: 100 },
      nftCompoundedAmountsByTokenId: { 7: { amount0: perNft, amount1: 0 } },
    },
  };
  _computeIL(snap, deps, lpValue, price, price, "7");
  return snap;
}

describe("IL/G excludes compounded fees", () => {
  it("removes lifetime compounded fees from the lifetime figure", () => {
    /*- 200 deposited, position worth 260 of which 60 is compounded
     *  fees. Divergence is nil, so IL must be nil. */
    assert.equal(run({ lpValue: 260, compounded: 60 }).lifetimeIL, 0);
  });

  it("removes only this NFT's compounds from the current figure", () => {
    /*- The current-NFT comparison starts at its own mint, which already
     *  contained the earlier compounds. */
    const snap = run({ lpValue: 260, compounded: 60, perNft: 25 });
    assert.equal(snap.totalIL, 235 - 200);
  });

  it("reports the same IL however much was compounded", () => {
    /*- Two positions with identical divergence must not differ in IL
     *  just because one reinvested more fees. */
    const a = run({ lpValue: 200, compounded: 0 });
    const b = run({ lpValue: 260, compounded: 60 });
    assert.equal(a.lifetimeIL, b.lifetimeIL);
  });

  it("still reports real divergence", () => {
    assert.equal(run({ lpValue: 150 }).lifetimeIL, -50);
  });

  it("publishes what it removed, for the IL/G popover", () => {
    const snap = run({ lpValue: 260, compounded: 60, perNft: 25 });
    assert.equal(snap.ilInputs.lt.compoundedRemoved, 60);
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 25);
    /*- lpValue stays the raw on-chain figure; the popover subtracts. */
    assert.equal(snap.ilInputs.lpValue, 260);
  });

  it("treats a missing per-NFT entry as nothing compounded", () => {
    const snap = run({ lpValue: 260, compounded: 60 });
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 0);
  });

  it("values this NFT's compounds at today's price, not the coin count", () => {
    /*-
     *  What is saved is 25 coins of token0. At $2 they are $50, so a
     *  position worth $460 against a $400 HODL diverges by $10.
     *
     *  Reading the saved number as dollars — which is what a stored
     *  total amounts to — would remove $25 and report $35. That error
     *  is the whole reason the app stores coins: it grows with every
     *  move the pair makes after the compound.
     */
    const snap = run({ lpValue: 460, compounded: 0, perNft: 25, price: 2 });
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 50);
    assert.equal(snap.totalIL, 10);
  });
});
