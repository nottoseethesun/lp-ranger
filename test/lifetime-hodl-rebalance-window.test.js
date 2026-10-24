/**
 * @file test/lifetime-hodl-rebalance-window.test.js
 * @description The scan a rebalance triggers, at the level of
 * `computeLifetimeHodl`.
 *
 * A rebalance mints with the wallet's whole balance of both pool tokens
 * (`src/lib/rebalancer.js`, steps 5 and 7), so coins that arrived in the
 * wallet since the previous mint are deposits in the new NFT. Finding
 * them means scanning the wallet's transfers between the two mints, and
 * these tests pin both halves of that: the coins are counted, and only
 * the one new boundary is scanned when the earlier ones are saved. Each
 * deposit found is entered on its own, at its own block and naming its
 * transaction, as the deposit count records one, so Total Lifetime
 * Deposit prices it at its own block and a rebuild from the chain enters
 * what the count recorded.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { computeLifetimeHodl } = require("../src/lib/lifetime-hodl");
const { totalLifetimeDeposit } = require("../src/lib/bot-deposit");
const {
  TRANSFER_TOPIC0,
  ilEvent,
  colEvent,
  dlEvent,
  mockProvider,
  mockEthers,
} = require("./helpers/lifetime-hodl-fixtures");

/*-
 *  Three NFTs: #1 minted at block 10, #2 at 1010, #3 at 5010 — the newest
 *  rebalance. Seven of token0 reached the wallet at block 3000, between
 *  the last two mints, and that rebalance's mint swept them in.
 */
const e = mockEthers();
const DEPOSIT = {
  address: "0xT0",
  topics: [
    TRANSFER_TOPIC0,
    e.zeroPadValue("0xExt", 32),
    e.zeroPadValue("0xW", 32),
  ],
  data: "0x" + 7n.toString(16).padStart(64, "0"),
  blockNumber: 3000,
  transactionHash: "0xdeposit",
};

/** The saved windows a rebalance leaves behind: everything up to #2. */
const SAVED_WINDOWS = {
  raw0: "0",
  raw1: "0",
  lastBlock: 1010,
  deposits: [{ raw0: "100", raw1: "200", block: 10 }],
};

/** A three-NFT chain whose newest mint follows the deposit. */
function chain() {
  const events = new Map();
  events.set("1", {
    ilEvents: [ilEvent(100, 200, 10)],
    collectEvents: [colEvent(100, 200, 1000)],
    dlEvents: [dlEvent(1000, 1000, 100, 200)],
  });
  events.set("2", {
    ilEvents: [ilEvent(100, 200, 1010)],
    collectEvents: [colEvent(100, 200, 5000)],
    dlEvents: [dlEvent(1000, 5000, 100, 200)],
  });
  events.set("3", {
    ilEvents: [ilEvent(107, 200, 5010)],
    collectEvents: [],
    dlEvents: [],
  });
  return events;
}

/** A transfer of token0 to the wallet from outside, in its own transaction. */
function arrival(amount, block, tx) {
  return {
    ...DEPOSIT,
    data: "0x" + BigInt(amount).toString(16).padStart(64, "0"),
    blockNumber: block,
    transactionHash: tx,
  };
}

/**
 * A deposit's entry of its own, at its block and naming its transaction:
 * the deposit count records one this way as the deposit arrives, and the
 * scan enters one this way for a deposit the count did not record.
 */
function entry(amount, block, tx) {
  return {
    raw0: String(amount),
    raw1: "0",
    block,
    kind: "fresh",
    txHash: tx,
  };
}

/** Run the computation, recording every block range it scanned. */
async function run(cachedFreshDeposits, logs = [DEPOSIT]) {
  const ranges = [];
  const inner = mockProvider({ logs });
  const provider = {
    getLogs: (f) => {
      ranges.push(`${f.fromBlock}-${f.toBlock}`);
      return inner.getLogs(f);
    },
    /*- Every transfer here arrives from outside, sent by its sender. */
    getTransaction: (hash) => Promise.resolve({ hash, from: "0xExt" }),
  };
  const r = await computeLifetimeHodl(chain(), {
    rebalanceEvents: [
      { oldTokenId: "1", newTokenId: "2" },
      { oldTokenId: "2", newTokenId: "3" },
    ],
    position: {
      tokenId: "3",
      token0: "0xT0",
      token1: "0xT1",
      decimals0: 0,
      decimals1: 0,
    },
    provider,
    ethersLib: e,
    walletAddress: "0xW",
    excludeFromAddrs: ["0xPM", "0xPOOL"],
    cachedFreshDeposits,
  });
  return { r, ranges: [...new Set(ranges)] };
}

describe("computeLifetimeHodl — the scan a rebalance triggers", () => {
  it("counts coins the rebalance swept in from the wallet", async () => {
    const { r } = await run(SAVED_WINDOWS);
    assert.strictEqual(r.amount0, 107, "the first mint plus the seven");
    assert.strictEqual(r.raw0, "7", "banked as a fresh deposit");
    /*- The saved entry as it was saved; the new one where the seven
     *  arrived, at block 3000, not at the mint's 5010. */
    assert.deepStrictEqual(r.deposits, [
      { raw0: "100", raw1: "200", block: 10 },
      entry(7, 3000, "0xdeposit"),
    ]);
  });

  it("enters each of the window's deposits at its own block", async () => {
    const { r } = await run(SAVED_WINDOWS, [
      DEPOSIT,
      arrival(5, 4500, "0xlater"),
    ]);
    assert.strictEqual(r.raw0, "12", "the window's total, as before");
    assert.deepStrictEqual(r.deposits.slice(1), [
      entry(7, 3000, "0xdeposit"),
      entry(5, 4500, "0xlater"),
    ]);
  });

  it("prices each of them at its own block for Total Lifetime Deposit", async () => {
    const { r } = await run(SAVED_WINDOWS, [
      DEPOSIT,
      arrival(5, 4500, "0xlater"),
    ]);
    const asked = [];
    const priceAt = { 10: 1, 3000: 2, 4500: 3 };
    const { total } = await totalLifetimeDeposit(r.deposits, 0, 0, (block) => {
      asked.push(block);
      return Promise.resolve({ price0: priceAt[block], price1: 1 });
    });
    assert.deepStrictEqual(asked, [10, 3000, 4500], "never the mint's 5010");
    assert.strictEqual(total, 100 + 200 + 7 * 2 + 5 * 3);
  });

  it("keeps a window an earlier version summed at its mint's block", async () => {
    /*- That version entered the window's deposits as one entry at the
     *  mint's block, naming no transaction. The window is not read
     *  again, so the entry stays as it was until a rebuild. */
    const saved = {
      raw0: "4",
      raw1: "0",
      lastBlock: 1010,
      deposits: [
        { raw0: "100", raw1: "200", block: 10 },
        { raw0: "4", raw1: "0", block: 1010 },
      ],
    };
    const { r, ranges } = await run(saved);
    assert.deepStrictEqual(ranges, ["1011-5010"]);
    assert.deepStrictEqual(r.deposits, [
      ...saved.deposits,
      entry(7, 3000, "0xdeposit"),
    ]);
    assert.strictEqual(r.raw0, "11");
  });

  it("scans only the newest boundary when the earlier ones are saved", async () => {
    const { ranges } = await run(SAVED_WINDOWS);
    assert.deepStrictEqual(ranges, ["1011-5010"]);
  });

  it("scans every boundary when nothing is saved", async () => {
    const { r, ranges } = await run(null);
    assert.deepStrictEqual(ranges, ["11-1010", "1011-5010"]);
    assert.strictEqual(r.amount0, 107, "same answer, more reading");
  });
});

describe("computeLifetimeHodl — deposits the deposit count recorded", () => {
  /*-
   *  The count recorded the seven at block 3000 when they arrived, so the
   *  saved results already hold them: in the fresh total, and as an entry
   *  at their own block, naming their transaction.
   */
  const COUNTED = {
    raw0: "7",
    raw1: "0",
    lastBlock: 1010,
    deposits: [
      { raw0: "100", raw1: "200", block: 10 },
      entry(7, 3000, "0xdeposit"),
    ],
    countedThrough: 4000,
  };

  it("leaves a recorded transaction out of the window, so it counts once", async () => {
    const { r } = await run(COUNTED);
    assert.strictEqual(r.amount0, 107, "the first mint plus the seven, once");
    assert.strictEqual(r.raw0, "7");
    assert.deepStrictEqual(r.deposits, COUNTED.deposits, "no second entry");
    assert.strictEqual(r.countedThrough, 4000, "how far the count read");
  });

  it("still counts what arrived after the count's last read", async () => {
    const { r } = await run(COUNTED, [DEPOSIT, arrival(5, 4500, "0xlater")]);
    assert.strictEqual(r.amount0, 112);
    assert.strictEqual(r.raw0, "12");
    assert.deepStrictEqual(r.deposits.at(-1), entry(5, 4500, "0xlater"));
  });

  it("enters the window's other deposits though a recorded one sits at the mint's block", async () => {
    const saved = {
      raw0: "3",
      raw1: "0",
      lastBlock: 1010,
      deposits: [
        { raw0: "100", raw1: "200", block: 10 },
        entry(3, 5010, "0xsame"),
      ],
    };
    const { r } = await run(saved, [DEPOSIT, arrival(3, 5010, "0xsame")]);
    assert.strictEqual(r.amount0, 110, "the mint, the three, the seven");
    assert.deepStrictEqual(r.deposits.slice(1), [
      entry(3, 5010, "0xsame"),
      entry(7, 3000, "0xdeposit"),
    ]);
  });

  it("enters, built again from the chain, the entries the count recorded", async () => {
    /*- Reload Current Position empties the results and builds them again
     *  from the chain. Each deposit the count recorded must come back
     *  where the count put it, at its own block, so Total Lifetime
     *  Deposit prices it as before. */
    const logs = [DEPOSIT, arrival(5, 4500, "0xlater")];
    const saved = {
      raw0: "12",
      raw1: "0",
      lastBlock: 1010,
      deposits: [
        { raw0: "100", raw1: "200", block: 10, kind: "fresh" },
        entry(7, 3000, "0xdeposit"),
        entry(5, 4500, "0xlater"),
      ],
      countedThrough: 5005,
    };
    const counted = await run(saved, logs);
    const rebuilt = await run(null, logs);
    assert.deepStrictEqual(rebuilt.r.deposits, counted.r.deposits);
    assert.strictEqual(rebuilt.r.raw0, counted.r.raw0);
    assert.strictEqual(rebuilt.r.amount0, counted.r.amount0);
  });
});
