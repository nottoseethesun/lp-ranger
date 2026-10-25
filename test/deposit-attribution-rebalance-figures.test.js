/**
 * @file test/deposit-attribution-rebalance-figures.test.js
 * @description A Rebalance entry's Activity Log figures for a coin another
 * running position holds (src/lib/rebalance-activity-figures.js): the
 * deposit set aside is what the running positions' deposits and moves
 * show the rebalance took (src/lib/deposit-attribution.js), in place of
 * the entries this position lists between the two mints.
 *
 * The fixture rebalance is the one test/rebalance-activity-figures.test.js
 * describes: the wallet held 100 of token0 and 50 of token1 before the
 * drain, 1,100 / 50 after it, and 600 / 545 before the mint at block
 * 1,000.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  cachedDepositFor,
  finishRebalanceFigures,
} = require("../src/lib/rebalance-activity-figures");

const READINGS = Object.freeze({
  beforeDrain: { amount0: 100, amount1: 50 },
  afterDrain: { amount0: 1100, amount1: 50 },
  beforeMint: { amount0: 600, amount1: 545 },
});
const MINT = 1000;

/** A deposit this position lists, of token0. */
const listed = (raw0, block, tx) => ({
  raw0: String(raw0),
  raw1: "0",
  block,
  kind: "fresh",
  txHash: tx,
});

describe("cachedDepositFor, given what the rebalance took", () => {
  const hodl = (deposits, lastBlock = MINT) => ({ deposits, lastBlock });

  it("takes it in place of the entries listed, beside an earlier version's entry at the mint", () => {
    const deposits = [
      listed(30, 600, "0xlisted"),
      { raw0: "5", raw1: "0", block: MINT },
    ];
    const taken = { amount0: 12, amount1: 3 };
    assert.deepEqual(
      cachedDepositFor(hodl(deposits), MINT, 0, 0, 500, taken),
      { amount0: 17, amount1: 3 },
      "the take in place of the 30 listed, beside the summed 5",
    );
    assert.equal(
      cachedDepositFor(hodl(deposits, MINT - 1), MINT, 0, 0, 500, taken),
      null,
      "still waiting until the accounting reaches the mint",
    );
  });
});

describe("finishRebalanceFigures, given what the rebalance took", () => {
  it("sets aside only that", async () => {
    /*-
     *  This position lists 80 at block 800, but another position holding
     *  the coin had already taken 50 of it into its own NFT, so this
     *  rebalance took 30.
     */
    const ev = {
      txHash: "0xmint",
      oldTokenId: "6",
      newTokenId: "7",
      blockNumber: MINT,
      timestamp: 1700000000,
      figuresDue: true,
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -7 },
    };
    const asked = [];
    const ctx = {
      decimals0: 0,
      decimals1: 0,
      lifetimeHodl: { deposits: [listed(80, 800, "0xa")], lastBlock: MINT },
      chainEvents: [{ oldTokenId: "5", newTokenId: "6", blockNumber: 700 }, ev],
      logged: new Map(),
      readNftEvents: async () => null,
      readBalances: async () => READINGS.beforeMint,
      historicalPrices: async () => ({ price0: 1, price1: 1 }),
      depositTakenAt: (block) => {
        asked.push(block);
        return { amount0: 30, amount1: 0 };
      },
    };
    const done = (await finishRebalanceFigures([ev], ctx)).get("0xmint");
    assert.deepEqual(done.beforeRebalance, { amount0: 1070, amount1: 50 });
    assert.deepEqual(asked, [MINT]);
  });
});
