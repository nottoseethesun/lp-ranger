/**
 * @file test/counted-deposits.test.js
 * @description What the deposit count's records add to the figures
 *   (src/counted-deposits.js).
 *
 *   A move's count saves each deposit into the pool's Lifetime results,
 *   naming its transaction; a poll's count holds what it finds in memory
 *   until the next move's. The Current IL/G and the Impermanent Loss Guard
 *   add the coins deposited since the current NFT's mint; the Lifetime
 *   figures, which hold the moves' counts already, add only what polls
 *   found since. And a Lifetime scan that ran while a count was saved
 *   keeps that count rather than writing over it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isCountedEntry,
  countedCoinsAfter,
  pollDeposits,
  plusDeposits,
  nftMintBlock,
  withLaterCounts,
} = require("../src/counted-deposits");

/** A deposit the count recorded: whole coins at two decimals. */
const counted = (tx, block, raw0, raw1, extra = {}) => ({
  raw0: String(raw0),
  raw1: String(raw1),
  block,
  kind: "fresh",
  txHash: tx,
  ...extra,
});

const LIFETIME = {
  lastBlock: 200,
  deposits: [
    // The Lifetime scan's own, at a mint: not one the count recorded.
    { raw0: "9900", raw1: "9900", block: 200, kind: "fresh" },
    counted("0xa", 150, 100, 0),
    counted("0xb", 250, 200, 300),
  ],
};
const OVERLAY = {
  through: 400,
  entries: [counted("0xc", 300, 0, 500, { usd: 12.5 })],
};

describe("the deposit count's records", () => {
  it("are the entries that name their transaction", () => {
    assert.equal(isCountedEntry(LIFETIME.deposits[1]), true);
    assert.equal(isCountedEntry(LIFETIME.deposits[0]), false);
    assert.equal(isCountedEntry(null), false);
  });

  it("add, after a block, the moves' counts and the polls' since", () => {
    assert.deepEqual(countedCoinsAfter(LIFETIME, OVERLAY, 200, 2, 2), {
      amount0: 2,
      amount1: 8,
    });
  });

  it("add nothing from the Lifetime scan's own entries, nor before the block", () => {
    assert.deepEqual(countedCoinsAfter(LIFETIME, null, 100, 2, 2), {
      amount0: 3,
      amount1: 3,
    });
  });

  it("stop at a last block when given one", () => {
    assert.deepEqual(countedCoinsAfter(LIFETIME, OVERLAY, 100, 2, 2, 250), {
      amount0: 3,
      amount1: 3,
    });
  });

  it("give the Lifetime figures only what polls found after the newest mint covered", () => {
    const overlay = {
      through: 400,
      entries: [counted("0xold", 190, 700, 0, { usd: 99 }), ...OVERLAY.entries],
    };
    assert.deepEqual(pollDeposits(LIFETIME, overlay, 2, 2), {
      amount0: 0,
      amount1: 5,
      usd: 12.5,
    });
    assert.deepEqual(pollDeposits(LIFETIME, null, 2, 2), {
      amount0: 0,
      amount1: 0,
      usd: 0,
    });
  });
});

describe("the coins a figure measures against", () => {
  it("take the deposits made since", () => {
    assert.deepEqual(
      plusDeposits({ amount0: 10, amount1: 0 }, { amount0: 1, amount1: 2 }),
      { amount0: 11, amount1: 2 },
    );
  });

  it("stay unknown while none are resolved, not the deposits alone", () => {
    assert.deepEqual(
      plusDeposits(
        { amount0: undefined, amount1: undefined },
        {
          amount0: 1,
          amount1: 2,
        },
      ),
      { amount0: undefined, amount1: undefined },
    );
    assert.deepEqual(plusDeposits(null, { amount0: 1, amount1: 2 }), {
      amount0: undefined,
      amount1: undefined,
    });
  });
});

describe("an NFT's mint block", () => {
  const chain = Object.assign(
    [
      { oldTokenId: "1", newTokenId: "2", blockNumber: 500 },
      { oldTokenId: "2", newTokenId: "3", blockNumber: 900 },
    ],
    { chainFirstTokenId: "1", chainFirstMintBlock: 100 },
  );

  it("comes from the rebalance that minted it", () => {
    assert.equal(nftMintBlock("3", chain), 900);
  });

  it("comes from the chain's first mint for the chain's first NFT", () => {
    assert.equal(nftMintBlock("1", chain), 100);
    const single = Object.assign([], {
      firstMintTokenId: "7",
      firstMintBlockNumber: 42,
    });
    assert.equal(nftMintBlock("7", single), 42);
  });

  it("is unknown when the events do not say", () => {
    assert.equal(nftMintBlock("8", chain), null);
    assert.equal(nftMintBlock("1", undefined), null);
  });
});

describe("a Lifetime scan's results, written over the saved ones", () => {
  const scanned = {
    amount0: 1,
    amount1: 1,
    raw0: "100",
    raw1: "100",
    lastBlock: 200,
    deposits: [counted("0xa", 150, 100, 0)],
    countedThrough: 160,
  };

  it("keep a count saved while the scan ran, once", () => {
    const latest = {
      deposits: [counted("0xA", 150, 100, 0), counted("0xd", 300, 50, 25)],
      countedThrough: 320,
    };
    const kept = withLaterCounts(scanned, latest, 2, 2);
    assert.deepEqual(
      kept.deposits.map((d) => d.txHash),
      ["0xa", "0xd"],
    );
    assert.equal(kept.raw0, "150");
    assert.equal(kept.raw1, "125");
    assert.equal(kept.amount0, 1.5);
    assert.equal(kept.amount1, 1.25);
    assert.equal(kept.countedThrough, 320);
  });

  it("are the scan's own when nothing landed meanwhile", () => {
    const latest = { deposits: [counted("0xa", 150, 100, 0)] };
    assert.equal(withLaterCounts(scanned, latest, 2, 2), scanned);
    assert.equal(withLaterCounts(scanned, null, 2, 2), scanned);
  });
});
