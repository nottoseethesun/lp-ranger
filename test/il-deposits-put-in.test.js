"use strict";

/**
 * @file test/il-deposits-put-in.test.js
 * @description How a deposit the owner made to the wallet counts in the
 *   IL/G figures and the Impermanent Loss Guard (`_computeIL`,
 *   src/lib/bot-pnl-il.js).
 *
 *   The Current IL/G and the Guard compare evenly, the user's ruling
 *   (2026-10-23): the coins the NFT was minted with, held, against those
 *   coins as the position holds them now. A deposit sitting in the wallet
 *   is in neither, so it moves neither, counted or not; once a compound
 *   takes it into the NFT, it is in the position's value, so it counts
 *   with the minted coins, from the compound's record. The Lifetime IL/G
 *   credits the wallet's coins to the position, so there a deposit reads
 *   as a gain until the deposit count records it as put in. The unmanaged
 *   details view shows the same Current IL/G as the bot.
 *
 *   Every case is a position minted at block 210 with 500 of each coin,
 *   at a dollar each, now worth $820, with 100 of coin A deposited at
 *   block 300 and sitting in the wallet.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkIlGuard } = require("../src/lib/il-guard");
const { _computeIL } = require("../src/lib/bot-pnl-il");
const { _currentPnl } = require("../src/lib/position-details-quick");

const TOKEN_ID = "100";
const DECIMALS = { decimals0: 0, decimals1: 0 };
const DEPOSIT = {
  raw0: "100",
  raw1: "0",
  block: 300,
  kind: "fresh",
  txHash: "0xdep",
};

/**
 * Work out a poll's figures, then ask the Guard, set to 15%, about them.
 * @param {object} o
 * @param {object} [o.lifetime]  The pool's Lifetime results.
 * @param {object} [o.overlay]  What a poll's count holds.
 * @param {object|null} [o.baseline]  The coins the NFT was minted with.
 * @param {number} [o.lpValue]  The position's value.
 * @param {number} [o.residual]  The wallet's coins.
 * @param {object} [o.compounded]  The NFT's Fees Compounded, in coins.
 * @param {object[]} [o.history]  The position's compound list.
 * @returns {{snap: object, verdict: object|null}}
 */
function poll({
  lifetime,
  overlay = null,
  baseline,
  lpValue = 820,
  residual = 100,
  compounded,
  history = [],
} = {}) {
  const deps = {
    position: { tokenId: TOKEN_ID, liquidity: "1000" },
    _getConfig: (k) => (k === "impermanentLossGuardPct" ? 15 : undefined),
    _rebalanceEvents: [
      { oldTokenId: "50", newTokenId: TOKEN_ID, blockNumber: 210 },
    ],
    _botState: {
      hodlBaseline:
        baseline === undefined
          ? { hodlAmount0: 500, hodlAmount1: 500 }
          : baseline,
      lifetimeHodlAmounts: lifetime ?? {
        amount0: 500,
        amount1: 500,
        lastBlock: 210,
        deposits: [],
      },
      _depositOverlay: overlay,
      nftCompoundedAmountsByTokenId:
        compounded === undefined ? {} : { [TOKEN_ID]: compounded },
      compoundHistory: history,
    },
    updateBotState: () => {},
  };
  const snap = { residualValueUsd: residual };
  _computeIL(snap, deps, lpValue, 1, 1, TOKEN_ID, DECIMALS);
  return { snap, verdict: checkIlGuard(deps, false, snap, () => ({})) };
}

/** The Lifetime results once a move's count has recorded the deposit. */
const RECORDED = {
  amount0: 600,
  amount1: 500,
  lastBlock: 210,
  deposits: [DEPOSIT],
};

describe("a deposit sitting in the wallet", () => {
  it("leaves the Current IL/G and the Guard alone, counted or not", () => {
    for (const lifetime of [undefined, RECORDED]) {
      const { snap, verdict } = poll({ lifetime });
      assert.equal(snap.ilInputs.cur.hodlAmount0, 500);
      assert.equal(snap.totalIL, -180, "the $180 loss, the $100 left out");
      assert.equal(verdict?.ilGuardRejected, true, "18% below: refused");
    }
  });

  it("reads as a gain in the Lifetime IL/G until a move's count records it", () => {
    assert.equal(poll().snap.lifetimeIL, -80);
    const { snap } = poll({ lifetime: RECORDED });
    assert.equal(snap.ilInputs.lt.hodlAmount0, 600);
    assert.equal(snap.lifetimeIL, -180);
  });

  it("is put in, in the Lifetime IL/G, while only a poll's count holds it", () => {
    const { snap } = poll({ overlay: { through: 400, entries: [DEPOSIT] } });
    assert.equal(snap.lifetimeIL, -180);
    assert.equal(snap.totalIL, -180);
  });
});

describe("a deposit a compound swept into the position", () => {
  /*-
   *  The compound collected 10 of coin A in fees, and its ratio swap's
   *  deposit took the wallet's whole balance, the 100 A deposit with
   *  them: the position is worth $930, and the wallet holds nothing. Its
   *  record names the 10 A as the fees its deposit put back, of the
   *  110 A it deposited (src/lib/compounded-coins.js).
   */
  const COMPOUND = {
    tokenId: TOKEN_ID,
    txHash: "0xcompound",
    trigger: "auto",
    amount0Deposited: "110",
    amount1Deposited: "0",
    amount0Compounded: "10",
    amount1Compounded: "0",
  };
  const swept = (history) =>
    poll({
      lifetime: RECORDED,
      lpValue: 930,
      residual: 0,
      compounded: { amount0: 10, amount1: 0 },
      history,
    });

  it("counts with the minted coins, so the figures read as before the compound", () => {
    const { snap, verdict } = swept([COMPOUND]);
    assert.equal(snap.ilInputs.cur.hodlAmount0, 600);
    assert.equal(snap.totalIL, -180);
    assert.equal(verdict?.ilGuardRejected, true, "16% below: refused");
  });

  it("would read as a gain of its size were it left out", () => {
    assert.equal(swept([]).snap.totalIL, -80);
  });

  it("is another NFT's when its record names another", () => {
    const { snap } = swept([{ ...COMPOUND, tokenId: "99" }]);
    assert.equal(snap.ilInputs.cur.hodlAmount0, 500);
  });
});

describe("what the figures leave alone", () => {
  it("a figure with no minted coins resolved, which stays unknown", () => {
    const { snap, verdict } = poll({ lifetime: RECORDED, baseline: null });
    assert.equal(snap.totalIL, undefined);
    assert.equal(verdict, null, "the Guard fails open, as before");
  });
});

describe("the unmanaged details view", () => {
  it("shows the Current IL/G the bot showed, with the wallet left out", () => {
    const quick = _currentPnl(
      { hodlAmount0: 500, hodlAmount1: 500 },
      820,
      0,
      0,
      1,
      1,
      { usd: 100 },
      0,
      { amount0: 0, amount1: 0 },
    );
    assert.equal(quick.il, poll({ lifetime: RECORDED }).snap.totalIL);
  });

  it("counts a swept deposit as the bot does", () => {
    const quick = _currentPnl(
      { hodlAmount0: 500, hodlAmount1: 500 },
      930,
      0,
      0,
      1,
      1,
      { usd: 0 },
      10,
      { amount0: 100, amount1: 0 },
    );
    assert.equal(quick.il, -180);
  });
});
