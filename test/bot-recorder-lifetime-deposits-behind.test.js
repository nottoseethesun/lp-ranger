"use strict";

/**
 * @file test/bot-recorder-lifetime-deposits-behind.test.js
 * @description A rebalance mints with the wallet's whole balance, and only
 *   the Lifetime scan counts what that mint took in from outside the
 *   position. The rebalance asks for that scan in memory, so a stop
 *   before the scan finishes drops the request, and at the next start
 *   every figure is saved. The deposit count's own mark, the newest mint
 *   its deposits cover (`lastBlock` in the epoch cache's lifetime
 *   figures), shows the gap from what is saved: while it stops short of
 *   the current NFT's mint, the scan reads the chain and recounts the
 *   deposits (`lifetimeScanPlan` and `_scanLifetimePoolData`,
 *   src/lib/bot-recorder-lifetime.js). Without that, Total Lifetime Deposit
 *   stays short of the coins the rebalance swept in until the next one.
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

/** Every lifetime figure saved, as at a start after a stop. */
const SAVED = Object.freeze({
  compoundedAmount0: 1.5,
  totalLifetimeDepositUsd: 100,
});

describe("the Lifetime scan, when the counted deposits stop short of the current NFT's mint", () => {
  let lifetime;

  beforeEach(() => {
    resetState();
    installMocks();
    lifetime = require("../src/lib/bot-recorder-lifetime");
  });

  afterEach(restoreMocks);

  const position = () => ({ ...makePosition(), tokenId: "7" });

  /** Run the scan on saved figures whose count reaches `lastBlock`. */
  async function scanWithCountAt(lastBlock) {
    state.cachedHodl = { poolAddress: "0xPOOL", lastBlock };
    const botState = makeBotState(SAVED);
    await lifetime._scanLifetimePoolData(
      position(),
      botState,
      () => {},
      [...EVENTS],
      "0xW",
      null,
      "epoch-key",
    );
    const { scanCalled, hodlComputed, depositCalled } = state;
    return { scanCalled, hodlComputed, depositCalled, botState };
  }

  /** The plan for saved figures, the count at `lastBlock` or none. */
  function planFor(cachedHodl, pos = position()) {
    state.cachedHodl = cachedHodl;
    return lifetime.lifetimeScanPlan(makeBotState(SAVED), "epoch-key", pos, [
      ...EVENTS,
    ]);
  }

  it("reads the chain and recounts the deposits", async () => {
    const got = await scanWithCountAt(MINT - 1);
    assert.equal(got.scanCalled, true, "the chain is read");
    assert.equal(got.hodlComputed, true, "the deposits are recounted");
    assert.equal(got.depositCalled, true, "and valued again");
    assert.notEqual(got.botState._needsFullRescan, true, "no request raised");
  });

  it("reads nothing once the count reaches the mint", async () => {
    const got = await scanWithCountAt(MINT);
    assert.equal(got.scanCalled, false);
    assert.equal(got.hodlComputed, false);
    assert.equal(got.depositCalled, false);
  });

  it("keeps a rebalance's own request apart from it", () => {
    const plan = planFor({ poolAddress: "0xPOOL", lastBlock: MINT - 1 });
    assert.equal(plan.fullRescan, false, "a request only a rebalance raises");
    assert.equal(plan.depositsBehind, true);
    assert.equal(plan.recountDeposits, true);
    assert.equal(plan.needed, true);
  });

  it("is no reason to read for an NFT no rebalance minted, or with no count saved", () => {
    // The chain's first NFT appears only as the old NFT of a rebalance.
    const first = planFor(
      { poolAddress: "0xPOOL", lastBlock: 0 },
      { tokenId: "6" },
    );
    assert.equal(first.depositsBehind, false);
    assert.equal(first.needed, false);
    // With no count saved, the scan counts for that reason instead.
    const none = planFor(null);
    assert.equal(none.depositsBehind, false);
    assert.equal(none.needed, true);
  });
});
