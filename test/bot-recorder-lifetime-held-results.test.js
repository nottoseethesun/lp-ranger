"use strict";

/**
 * @file test/bot-recorder-lifetime-held-results.test.js
 * @description A Lifetime scan that does not count the deposits again
 *   keeps the Lifetime results the bot holds (`_scanLifetimePoolData`,
 *   src/lib/bot-recorder-lifetime.js).
 *
 *   A Re-scan Prices scan, for one, reads the saved results when it
 *   starts and does not count again. A deposit count during that scan,
 *   for a Compound Now, saves newer results than the copy the scan read.
 *   Putting that copy back would drop the count's deposits, so both IL/G
 *   figures and Total Lifetime Deposit would read them as a gain until
 *   the next count. With no results held, as when the P&L tracker could
 *   not start for want of a price, the scan takes the saved ones.
 *
 *   Driven through the scan with the shared harness's stand-ins for the
 *   chain read and the deposit count.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

const MINT = 5000;

/** The rebalance that minted the current NFT, #7. */
const EVENTS = Object.freeze([
  Object.freeze({ oldTokenId: "6", newTokenId: "7", blockNumber: MINT }),
]);

/** Every lifetime figure saved, so only Re-scan Prices asks for the scan. */
const SAVED = Object.freeze({
  compoundedAmount0: 1.5,
  totalLifetimeDepositUsd: 100,
});

describe("a Lifetime scan that does not count the deposits again", () => {
  let lifetime;

  beforeEach(() => {
    resetState();
    installMocks();
    lifetime = require("../src/lib/bot-recorder-lifetime");
  });

  afterEach(restoreMocks);

  /** Run a Re-scan Prices scan for the bot state given. */
  async function rescanPrices(botState) {
    state.cachedHodl = { poolAddress: "0xPOOL", lastBlock: MINT, deposits: [] };
    botState._needsPriceRevalue = true;
    await lifetime._scanLifetimePoolData(
      { ...makePosition(), tokenId: "7" },
      botState,
      () => {},
      [...EVENTS],
      "0xW",
      null,
      "epoch-key",
    );
  }

  it("keeps the results a deposit count saved while it ran", async () => {
    const botState = makeBotState(SAVED);
    botState.lifetimeHodlAmounts = { ...state.cachedHodl, deposits: [] };
    const counted = {
      poolAddress: "0xPOOL",
      lastBlock: MINT,
      deposits: [{ raw0: "1", raw1: "0", block: MINT + 9, txHash: "0xd" }],
      countedThrough: MINT + 10,
    };
    state.duringRead = () => {
      botState.lifetimeHodlAmounts = counted;
    };
    await rescanPrices(botState);
    assert.equal(state.scanCalled, true, "the chain was read");
    assert.equal(state.hodlComputed, false, "the deposits were not counted");
    assert.equal(botState.lifetimeHodlAmounts, counted);
  });

  it("takes the saved results when it holds none", async () => {
    const botState = makeBotState(SAVED);
    await rescanPrices(botState);
    assert.deepEqual(botState.lifetimeHodlAmounts, {
      poolAddress: "0xPOOL",
      lastBlock: MINT,
      deposits: [],
    });
  });
});
