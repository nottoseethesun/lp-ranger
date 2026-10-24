"use strict";

/**
 * @file test/lifetime-hodl-recorded-compounds.test.js
 * @description The Lifetime scan's tally counts no compound this install
 *   made as money put in (`computeLifetimeHodl`, src/lib/lifetime-hodl.js).
 *
 *   An addition of liquidity after an NFT's mint is a compound while the
 *   additions so far stay within the NFT's fees, and otherwise money put
 *   in, all of it. The case the user reported: a compound collects 10 +
 *   10 of fees while the wallet holds a deposit of 100 + 100 (or the
 *   coins the first mint left), and its swap's deposit takes all 110 +
 *   110. That far exceeds the NFT's fees, so the fee test alone calls the
 *   whole deposit, fees and all, money put in: added to holding, with the
 *   deposit counted twice, and the Initial Wallet Residual counted as put
 *   in while Lifetime Net P&L subtracts it. A compound this install made
 *   took only the wallet's coins, each counted where it reached the
 *   wallet.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeLifetimeHodl } = require("../src/lib/lifetime-hodl");
const { ilEvent, colEvent } = require("./helpers/lifetime-hodl-fixtures");

/** A position of two 8-decimal coins. */
const POSITION = { tokenId: "100", decimals0: 8, decimals1: 8 };

/**
 * NFT #100: minted with 1,000 + 2,000, its fees of 10 + 10 collected at
 * block 400, and 110 + 110 added at block 500 (transaction `0x1f4`).
 * @param {object[]} [extra]  Later additions.
 */
function sweptNft(extra = []) {
  const events = new Map();
  events.set("100", {
    ilEvents: [
      ilEvent(1000_00000000, 2000_00000000, 10),
      ilEvent(110_00000000, 110_00000000, 500),
      ...extra,
    ],
    collectEvents: [colEvent(10_00000000, 10_00000000, 400)],
    dlEvents: [],
  });
  return events;
}

/** The tally over `events`, with the position's compound list. */
function tally(events, compoundHistory) {
  return computeLifetimeHodl(events, {
    rebalanceEvents: [],
    position: POSITION,
    compoundHistory,
  });
}

describe("the Lifetime tally and the compounds this install made", () => {
  it("counts no compound this install made as money put in, whatever its size", async () => {
    const r = await tally(sweptNft(), [
      {
        txHash: "0x1F4",
        trigger: "auto",
        amount0Deposited: "11000000000",
        amount1Deposited: "11000000000",
        amount0Compounded: "1000000000",
        amount1Compounded: "1000000000",
      },
    ]);
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2000);
    assert.deepStrictEqual(
      r.deposits.map((d) => d.kind),
      ["fresh"],
      "no external deposit is recorded for it",
    );
  });

  it("counts one recorded before its fees were kept as no money put in either", async () => {
    const r = await tally(sweptNft(), [{ txHash: "0x1f4", trigger: "manual" }]);
    assert.strictEqual(r.amount0, 1000);
  });

  it("judges a compound found only on the chain by the NFT's fees, as before", async () => {
    const r = await tally(sweptNft(), [
      { txHash: "0x1f4", trigger: "unknown" },
    ]);
    assert.strictEqual(r.amount0, 1110);
    assert.strictEqual(r.amount1, 2110);
  });

  it("uses up only the fees a recorded compound put back", async () => {
    /*-
     *  The NFT's fees are 20 + 20: the recorded compound put back 10 + 10
     *  of them, so a later addition of 10 + 10 the chain alone shows still
     *  fits, and is a compound. Counting the recorded compound's whole 110
     *  against the fees would make it money put in.
     */
    const events = sweptNft([ilEvent(10_00000000, 10_00000000, 700)]);
    events
      .get("100")
      .collectEvents.push(colEvent(10_00000000, 10_00000000, 650));
    const r = await tally(events, [
      {
        txHash: "0x1f4",
        trigger: "auto",
        amount0Compounded: "1000000000",
        amount1Compounded: "1000000000",
      },
    ]);
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2000);
  });
});
