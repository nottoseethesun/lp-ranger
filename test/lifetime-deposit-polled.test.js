/**
 * @file test/lifetime-deposit-polled.test.js
 * @description Total Lifetime Deposit adds the deposits a poll's count
 *   found since the last move's count (`overridePnlWithRealValues`,
 *   src/lib/bot-pnl-updater.js).
 *
 *   A move's count saves its deposits into the Lifetime results, where
 *   they are priced into the saved total. A poll's count between moves
 *   is held in memory, so the figure adds what it holds, each deposit at
 *   its own block's price, until the next move's count records the same
 *   deposits in its place. Lifetime Net P&L is built on this figure, and
 *   without it a deposit sitting in the wallet reads there as profit.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { overridePnlWithRealValues } = require("../src/lib/bot-pnl-updater");
const { _resetForTest } = require("../src/lib/gecko-rate-limit");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

const POS = {
  tokenId: "100",
  liquidity: 1000n,
  tickLower: -600,
  tickUpper: 600,
};
const POOL = { tick: 0, decimals0: 0, decimals1: 0 };

/** A deposit a poll's count holds, at block `block`, worth `usd`. */
const polled = (block, usd, tx) => ({
  raw0: "5",
  raw1: "0",
  block,
  kind: "fresh",
  txHash: tx,
  usd,
});

/** The figure Total Lifetime Deposit shows, for a bot state. */
async function lifetimeDeposit(botState) {
  const snap = { liveEpoch: { entryValue: 500 }, totalGas: 0 };
  await overridePnlWithRealValues(
    snap,
    { _botState: botState },
    POS,
    POOL,
    1,
    1,
    0,
    null,
  );
  return snap.totalLifetimeDeposit;
}

describe("Total Lifetime Deposit", () => {
  it("adds the deposits a poll counted after the newest mint covered", async () => {
    const got = await lifetimeDeposit({
      totalLifetimeDepositUsd: 500,
      lifetimeHodlAmounts: { lastBlock: 210, deposits: [] },
      _depositOverlay: {
        through: 400,
        entries: [polled(150, 99, "0xin-the-mint"), polled(300, 25, "0xa")],
      },
    });
    assert.equal(got, 525, "the one at block 150 is in the mint's count");
  });

  it("is the saved total when no poll has counted anything since", async () => {
    const got = await lifetimeDeposit({
      totalLifetimeDepositUsd: 500,
      lifetimeHodlAmounts: { lastBlock: 210, deposits: [] },
      _depositOverlay: null,
    });
    assert.equal(got, 500);
  });

  it("stays unset while the Lifetime scan has no total yet", async () => {
    const got = await lifetimeDeposit({
      totalLifetimeDepositUsd: 0,
      lifetimeHodlAmounts: { lastBlock: 210, deposits: [] },
      _depositOverlay: { through: 400, entries: [polled(300, 25, "0xa")] },
    });
    assert.equal(got, undefined);
  });
});
