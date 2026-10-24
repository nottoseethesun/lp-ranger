/**
 * @file test/current-lp-deposit.test.js
 * @description What Initial Deposit for This LP adds to the coins an NFT
 * was minted with (src/lib/current-lp-deposit.js): the wallet's coins its
 * compounds took in beyond their fees, each at that compound's prices.
 *
 * The coins here have no decimals, so a record's amounts are whole coins.
 * The compound on NFT #7 deposited 10 of token0 and 2 of token1, of which
 * 6 and 2 were its own fees: it took 4 of token0 from the wallet.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { addedByCompounds } = require("../src/lib/current-lp-deposit");

const DECIMALS = { decimals0: 0, decimals1: 0 };
const TODAY = { price0: 2, price1: 1 };

/** A compound of NFT #7 that took 4 of token0 in beyond its fees. */
function compound(over = {}) {
  return {
    tokenId: "7",
    txHash: "0xc1",
    timestamp: "2026-10-20T12:00:00Z",
    blockNumber: 500,
    amount0Deposited: "10",
    amount1Deposited: "2",
    amount0Compounded: "6",
    amount1Compounded: "2",
    ...over,
  };
}

describe("addedByCompounds", () => {
  it("values the coins a compound took from the wallet at the prices the bot recorded with it", async () => {
    const got = await addedByCompounds(
      [compound({ price0: 3, price1: 5 })],
      7,
      DECIMALS,
      null,
      TODAY,
    );
    assert.deepEqual(got, { usd: 12, fallback: false }, "4 coins at $3");
  });

  it("asks for the prices at the compound's block when its record has none, as a rebuild leaves it", async () => {
    const asked = [];
    const pricesAt = async (timestamp, blockNumber) => {
      asked.push([timestamp, blockNumber]);
      return { price0: 4, price1: 5 };
    };
    const got = await addedByCompounds(
      [compound()],
      "7",
      DECIMALS,
      pricesAt,
      TODAY,
    );
    assert.deepEqual(got, { usd: 16, fallback: false }, "4 coins at $4");
    assert.deepEqual(asked, [["2026-10-20T12:00:00Z", 500]]);
  });

  it("values them at today's prices, flagged, when the compound's own are not found", async () => {
    const none = async () => null;
    assert.deepEqual(
      await addedByCompounds([compound()], "7", DECIMALS, none, TODAY),
      { usd: 8, fallback: true },
      "4 coins at today's $2",
    );
    const failing = async () => {
      throw new Error("no price service answered");
    };
    assert.deepEqual(
      await addedByCompounds([compound()], "7", DECIMALS, failing, TODAY),
      { usd: 8, fallback: true },
      "a lookup that fails is a price not found",
    );
  });

  it("flags only a missing price of a coin the compound took", async () => {
    // Its record carries token0's price only; it took none of token1.
    const got = await addedByCompounds(
      [compound({ price0: 3, price1: 0 })],
      "7",
      DECIMALS,
      async () => ({ price0: 3, price1: 0 }),
      TODAY,
    );
    assert.deepEqual(got, { usd: 12, fallback: false });
  });

  it("adds nothing for a compound that does not tell its fees apart, another NFT's, or one that took nothing", async () => {
    const asked = [];
    const pricesAt = async () => {
      asked.push(true);
      return { price0: 4, price1: 5 };
    };
    const history = [
      { tokenId: "7", amount0Deposited: "50", amount1Deposited: "0" },
      compound({ tokenId: "8" }),
      compound({ amount0Compounded: "10" }),
      "not a record",
    ];
    assert.deepEqual(
      await addedByCompounds(history, "7", DECIMALS, pricesAt, TODAY),
      { usd: 0, fallback: false },
    );
    assert.deepEqual(asked, [], "no price is asked for none of them");
    assert.deepEqual(
      await addedByCompounds(undefined, "7", DECIMALS, pricesAt, TODAY),
      { usd: 0, fallback: false },
      "no compound list at all",
    );
  });

  it("sums every compound of the NFT, each at its own prices", async () => {
    const history = [
      compound({ price0: 3, price1: 5 }),
      compound({
        txHash: "0xc2",
        amount0Deposited: "1",
        amount1Deposited: "9",
        amount0Compounded: "1",
        amount1Compounded: "6",
        price0: 3,
        price1: 5,
      }),
    ];
    assert.deepEqual(
      await addedByCompounds(history, "7", DECIMALS, null, TODAY),
      { usd: 12 + 15, fallback: false },
      "4 of token0 at $3, then 3 of token1 at $5",
    );
  });
});
