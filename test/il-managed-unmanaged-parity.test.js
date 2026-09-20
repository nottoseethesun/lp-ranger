/**
 * @file test/il-managed-unmanaged-parity.test.js
 * @description A position reports the same IL/G whether or not the bot
 *   manages it.
 *
 *   Managing a position changes nothing on chain, so nothing on screen
 *   may move when it starts or stops. The two tiers reach the figure by
 *   different routes — the bot from its own state, the details endpoint
 *   from a scan — and the only thing keeping them equal is that both go
 *   through `ilFigures`.
 *
 *   The failure this guards against: the view tier comparing the raw LP
 *   value against HODL, leaving compounded fees in. Those fees are
 *   liquidity the HODL side never had, so they read as LP
 *   outperformance — and Profit counts them a second time as earnings.
 *   The gap is the whole compounded amount, which on a long-running
 *   position is large enough to flip the sign.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _computeIL, ilFigures } = require("../src/bot-pnl-il");
const { _currentPnl } = require("../src/position-details-quick");

/*- One position, described once, so the two tiers cannot drift apart in
 *  the fixture rather than in the code. */
const POS = {
  lpValue: 5000,
  residual: 12,
  price0: 1,
  price1: 2,
  curHodl: { amount0: 2000, amount1: 1000 },
  ltHodl: { amount0: 2400, amount1: 1100 },
  tokenId: "164418",
  /*- The coins this NFT compounded, and what the position compounded
   *  across its whole life. Priced below at the same prices. */
  curCoins: { amount0: 300, amount1: 150 },
  ltCoins: { amount0: 700, amount1: 205.58 },
};
const CUR_COMP =
  POS.curCoins.amount0 * POS.price0 + POS.curCoins.amount1 * POS.price1;
const LT_COMP =
  POS.ltCoins.amount0 * POS.price0 + POS.ltCoins.amount1 * POS.price1;

/** What the bot tier publishes for this position. */
function managed() {
  const snap = {
    residualValueUsd: POS.residual,
    totalCompoundedUsd: LT_COMP,
    closedEpochs: [],
  };
  const deps = {
    _botState: {
      hodlBaseline: {
        hodlAmount0: POS.curHodl.amount0,
        hodlAmount1: POS.curHodl.amount1,
      },
      lifetimeHodlAmounts: POS.ltHodl,
      nftCompoundedAmountsByTokenId: { [POS.tokenId]: POS.curCoins },
    },
  };
  _computeIL(snap, deps, POS.lpValue, POS.price0, POS.price1, POS.tokenId);
  return snap;
}

/** What the details endpoint publishes for the same position. */
function unmanaged() {
  return ilFigures({
    lpValue: POS.lpValue,
    residualValueUsd: POS.residual,
    price0: POS.price0,
    price1: POS.price1,
    curHodl: POS.curHodl,
    ltHodl: POS.ltHodl,
    curCompoundedUsd: CUR_COMP,
    ltCompoundedUsd: LT_COMP,
  });
}

describe("IL/G is the same managed and unmanaged", () => {
  it("agrees on the current-NFT figure", () => {
    assert.equal(managed().totalIL, unmanaged().totalIL);
  });

  it("agrees on the lifetime figure", () => {
    assert.equal(managed().lifetimeIL, unmanaged().lifetimeIL);
  });

  it("agrees on what each side removed, for the IL/G popover", () => {
    const m = managed().ilInputs,
      u = unmanaged().ilInputs;
    assert.equal(m.cur.compoundedRemoved, u.cur.compoundedRemoved);
    assert.equal(m.lt.compoundedRemoved, u.lt.compoundedRemoved);
    assert.equal(m.lpValue, u.lpValue);
    assert.equal(m.residualValueUsd, u.residualValueUsd);
  });

  it("both actually remove the compounded fees", () => {
    /*- Without this the pair could agree by being wrong together.
     *
     *  Compared with a tolerance: the two sides reach the same figure by
     *  different orders of operation, and dollars are binary floats, so
     *  the difference lands within a rounding step rather than on it.
     *  The parity assertions above stay exact — there both sides run the
     *  same arithmetic in the same order. */
    const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + " vs " + b);
    const withNone = ilFigures({
      lpValue: POS.lpValue,
      residualValueUsd: POS.residual,
      price0: POS.price0,
      price1: POS.price1,
      curHodl: POS.curHodl,
      ltHodl: POS.ltHodl,
      curCompoundedUsd: 0,
      ltCompoundedUsd: 0,
    });
    closeTo(withNone.totalIL - managed().totalIL, CUR_COMP);
    closeTo(withNone.lifetimeIL - managed().lifetimeIL, LT_COMP);
    assert.ok(LT_COMP > 1000, "fixture must be large enough to matter");
  });
});

describe("the fast details path removes this NFT's compounds too", () => {
  /*- `_currentPnl` answers before any scan, from the coins on disk. It
   *  must not publish a figure the full response then contradicts. */
  const baseline = {
    hodlAmount0: POS.curHodl.amount0,
    hodlAmount1: POS.curHodl.amount1,
  };
  const residuals = { usd: POS.residual };

  it("matches the managed current-NFT figure", () => {
    const quick = _currentPnl(
      baseline,
      POS.lpValue,
      0,
      0,
      POS.price0,
      POS.price1,
      residuals,
      CUR_COMP,
    );
    assert.equal(quick.il, managed().totalIL);
  });

  it("reports no IL without a baseline, rather than a zero", () => {
    const quick = _currentPnl(null, POS.lpValue, 0, 0, 1, 1, residuals, 0);
    assert.equal(quick.il, null);
  });

  it("treats an absent compounded figure as nothing removed", () => {
    /*- A slot with no saved coins yet: the fast path still answers, and
     *  the full response corrects it. */
    const noArg = _currentPnl(
      baseline,
      POS.lpValue,
      0,
      0,
      POS.price0,
      POS.price1,
      residuals,
    );
    const zero = _currentPnl(
      baseline,
      POS.lpValue,
      0,
      0,
      POS.price0,
      POS.price1,
      residuals,
      0,
    );
    assert.equal(noArg.il, zero.il);
  });
});
