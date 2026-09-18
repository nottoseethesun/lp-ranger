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
 *  Every number here is distinct, deliberately.
 *
 *  The two comparisons differ only in which deposits and which
 *  compounded total they use, so a fixture that gave them the same
 *  amounts would pass just as happily with the two swapped. The same
 *  goes for the tokens: equal prices hide a side being dropped, and a
 *  zero residual hides the residual not being credited at all.
 *
 *    current NFT's deposit : 100 token0 + 50 token1
 *    lifetime deposit      : 120 token0 + 60 token1
 *    wallet residual       : $10
 *    prices                : token0 $1, token1 $2  (so 200 and 240)
 */
const CUR_HODL = { amount0: 100, amount1: 50 };
const LT_HODL = { amount0: 120, amount1: 60 };
const RESIDUAL = 10;

/*-
 *  Run _computeIL over a position worth `lpValue`. `perNft` is the COINS
 *  of token0 this NFT compounded, not their value: what is saved is
 *  coins, and pricing them is the function's job.
 */
function run({ lpValue, compounded = 0, perNft = 0, p0 = 1, p1 = 2 }) {
  const snap = {
    residualValueUsd: RESIDUAL,
    totalCompoundedUsd: compounded,
  };
  const deps = {
    _botState: {
      hodlBaseline: {
        hodlAmount0: CUR_HODL.amount0,
        hodlAmount1: CUR_HODL.amount1,
      },
      lifetimeHodlAmounts: LT_HODL,
      nftCompoundedAmountsByTokenId: { 7: { amount0: perNft, amount1: 0 } },
    },
  };
  _computeIL(snap, deps, lpValue, p0, p1, "7");
  return snap;
}

describe("IL/G excludes compounded fees", () => {
  it("removes lifetime compounded fees from the lifetime figure", () => {
    /*- (290 − 60 compounded + 10 residual) − 240 deposited = 0.
     *  Divergence is nil, so IL must be nil. */
    assert.equal(run({ lpValue: 290, compounded: 60 }).lifetimeIL, 0);
  });

  it("removes only this NFT's compounds from the current figure", () => {
    /*- The current-NFT comparison starts at its own mint, which already
     *  contained the earlier compounds — 25 of them, not the lifetime 60.
     *  (290 − 25 + 10) − 200 = 75. Against the LIFETIME total it would
     *  be 40, and against the lifetime DEPOSIT 35, so this one figure
     *  separates all three. */
    assert.equal(run({ lpValue: 290, compounded: 60, perNft: 25 }).totalIL, 75);
  });

  it("reports the same IL however much was compounded", () => {
    /*- Two positions with identical divergence must not differ in IL
     *  just because one reinvested more fees. */
    const a = run({ lpValue: 230, compounded: 0 });
    const b = run({ lpValue: 290, compounded: 60 });
    assert.equal(a.lifetimeIL, b.lifetimeIL);
  });

  it("still reports real divergence", () => {
    /*- (150 + 10) − 240 = −80. */
    assert.equal(run({ lpValue: 150 }).lifetimeIL, -80);
  });

  it("credits the wallet residual to the LP side", () => {
    /*- Coins the LP handed back and will fold in on the next rebalance.
     *  Without the credit, IL/G overstates the loss by exactly them. */
    const snap = run({ lpValue: 150 });
    assert.equal(snap.ilInputs.residualValueUsd, RESIDUAL);
    assert.equal(snap.lifetimeIL, 150 + RESIDUAL - 240);
  });

  it("publishes what it removed, for the IL/G popover", () => {
    const snap = run({ lpValue: 290, compounded: 60, perNft: 25 });
    assert.equal(snap.ilInputs.lt.compoundedRemoved, 60);
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 25);
    /*- Each side's own deposits, which differ — so the popover cannot be
     *  showing one where it means the other. */
    assert.equal(snap.ilInputs.cur.hodlAmount1, CUR_HODL.amount1);
    assert.equal(snap.ilInputs.lt.hodlAmount1, LT_HODL.amount1);
    /*- lpValue stays the raw on-chain figure; the popover subtracts. */
    assert.equal(snap.ilInputs.lpValue, 290);
  });

  it("compares each figure against its own deposits", () => {
    /*- The lifetime deposit is larger than this NFT's, so the two
     *  figures must differ by exactly that difference. */
    const snap = run({ lpValue: 290 });
    assert.equal(snap.totalIL - snap.lifetimeIL, 240 - 200);
  });

  it("treats a missing per-NFT entry as nothing compounded", () => {
    const snap = run({ lpValue: 290, compounded: 60 });
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 0);
  });

  it("values this NFT's compounds at today's price, not the coin count", () => {
    /*-
     *  Both prices doubled: token0 $2, token1 $4, so this NFT's deposit
     *  is worth 400. What is saved is 25 coins of token0, now $50.
     *  (450 − 50 + 10) − 400 = 10.
     *
     *  Reading the saved number as dollars — which is what a stored
     *  total amounts to — would remove $25 and report $35. That error
     *  is the whole reason the app stores coins: it grows with every
     *  move the pair makes after the compound.
     */
    const snap = run({ lpValue: 450, perNft: 25, p0: 2, p1: 4 });
    assert.equal(snap.ilInputs.cur.compoundedRemoved, 50);
    assert.equal(snap.totalIL, 10);
  });
});
