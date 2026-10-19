/**
 * @file test/pool-scanner-helpers.test.js
 * @description Tests for getPoolScanLock and clearPoolCache in pool-scanner.js.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const {
  getPoolScanLock,
  clearPoolCache,
  appendToPoolCache,
} = require("../src/pool-scanner");
const { createCacheStore, eventCachePath } = require("../src/cache-store");
const { buildCacheKey } = require("../src/event-scanner");
const config = require("../src/config");

/*-
 *  Read back what the cache holds for a position, through the same path
 *  the writer used.
 *
 *  Without this the tests below could only observe that a call did not
 *  throw — which a function that did nothing at all would also satisfy,
 *  and which is what these assertions used to amount to.
 */
async function readPoolCache(position, wallet) {
  const store = createCacheStore({
    filePath: eventCachePath(
      position,
      "pulsechain",
      config.POSITION_MANAGER,
      wallet,
    ),
    defaultTtlMs: 60_000,
  });
  return store.get(
    buildCacheKey(
      wallet,
      config.POSITION_MANAGER,
      position.token0,
      position.token1,
      position.fee,
    ),
  );
}

// ── getPoolScanLock ─────────────────────────────────────────────────

describe("getPoolScanLock", () => {
  it("returns a mutex-like object", () => {
    const lock = getPoolScanLock("0xA", "0xB", 3000);
    assert.ok(lock);
    assert.strictEqual(typeof lock.acquire, "function");
    assert.strictEqual(typeof lock.isLocked, "function");
  });

  it("returns same lock for same pool", () => {
    const l1 = getPoolScanLock("0xA", "0xB", 3000);
    const l2 = getPoolScanLock("0xA", "0xB", 3000);
    assert.strictEqual(l1, l2);
  });

  it("returns different lock for different pool", () => {
    const l1 = getPoolScanLock("0xA", "0xB", 3000);
    const l2 = getPoolScanLock("0xA", "0xB", 500);
    assert.notStrictEqual(l1, l2);
  });

  it("is case-insensitive", () => {
    const l1 = getPoolScanLock("0xABC", "0xDEF", 3000);
    const l2 = getPoolScanLock("0xabc", "0xdef", 3000);
    assert.strictEqual(l1, l2);
  });

  it("handles string fee values", () => {
    const l1 = getPoolScanLock("0xA", "0xB", "10000");
    const l2 = getPoolScanLock("0xA", "0xB", 10000);
    // These will be the same since both stringify to the same key
    assert.strictEqual(l1, l2);
  });
});

// ── clearPoolCache ──────────────────────────────────────────────────

describe("clearPoolCache", () => {
  it("removes what the cache held for that position", async () => {
    /*- The old test only ran the call and asserted nothing, so a
     *  `clearPoolCache` that did nothing at all would have passed it.
     *  Seed the cache first, then clear, then look. */
    const position = {
      token0: "0x6666666666666666666666666666666666666666",
      token1: "0x7777777777777777777777777777777777777777",
      fee: 500,
    };
    await appendToPoolCache(position, "0xWallet0000", {
      oldTokenId: "300",
      newTokenId: "301",
      txHashes: ["0xhash3"],
      blockNumber: 1234,
    });
    const seeded = await readPoolCache(position, "0xWallet0000");
    assert.ok(
      (seeded?.events || []).some((e) => e.newTokenId === "301"),
      "precondition: the cache must hold something to clear",
    );

    await clearPoolCache(position, "0xWallet0000");

    const after = await readPoolCache(position, "0xWallet0000");
    assert.ok(
      !(after?.events || []).some((e) => e.newTokenId === "301"),
      "the cleared entry must be gone",
    );
  });

  it("does not throw when there is nothing cached to clear", async () => {
    /*- A pool the app has never scanned: clearing is a no-op, not an
     *  error, because the caller clears before it knows. */
    await assert.doesNotReject(() =>
      clearPoolCache(
        { token0: "0xAAAA0000", token1: "0xBBBB0000", fee: 500 },
        "0xWalletNeverSeen",
      ),
    );
  });
});

// ── appendToPoolCache ───────────────────────────────────────────────

describe("appendToPoolCache", () => {
  it("appends event with array txHashes", async () => {
    const position = {
      token0: "0x2222222222222222222222222222222222222222",
      token1: "0x3333333333333333333333333333333333333333",
      fee: 3000,
    };
    await appendToPoolCache(position, "0xWallet1111", {
      oldTokenId: "100",
      newTokenId: "101",
      txHashes: ["0xhash1", "0xhash2"],
      blockNumber: 9999,
    });

    /*- Read it back. The event has to be IN the cache; a write that
     *  silently did nothing would leave this empty while still not
     *  throwing, which is all the old test asked for. */
    const cached = await readPoolCache(position, "0xWallet1111");
    const ev = (cached?.events || []).find((e) => e.newTokenId === "101");
    assert.ok(ev, "the appended event must be in the cache");
    assert.equal(ev.oldTokenId, "100");
    assert.equal(ev.blockNumber, 9999);
    /*- The array collapses to ONE hash, and specifically the last. A
     *  rebalance submits several transactions — remove, swap, mint — and
     *  the mint is the one that identifies the event, so the stored hash
     *  is the tail rather than the head. Nothing pinned that before. */
    assert.equal(ev.txHash, "0xhash2");
  });

  it("handles missing txHashes gracefully", async () => {
    const position = {
      token0: "0x4444444444444444444444444444444444444444",
      token1: "0x5555555555555555555555555555555555555555",
      fee: 500,
    };
    await appendToPoolCache(position, "0xWallet2222", {
      oldTokenId: "200",
      newTokenId: "201",
      blockNumber: 6100,
    });

    /*- "Gracefully" has to mean something observable: the event lands,
     *  and the absent hashes do not take the rest of it down with them. */
    const cached = await readPoolCache(position, "0xWallet2222");
    const ev = (cached?.events || []).find((e) => e.newTokenId === "201");
    assert.ok(ev, "an event without txHashes must still be stored");
    assert.equal(ev.oldTokenId, "200");
    assert.equal(ev.blockNumber, 6100);
    /*- An empty string, not undefined: the dashboard renders this field
     *  and a missing one would print "undefined" in the events table. */
    assert.equal(ev.txHash, "");
  });
});

describe("appendToPoolCache — beside a scan of the same pool", () => {
  const position = {
    token0: "0x8888888888888888888888888888888888888888",
    token1: "0x9999999999999999999999999999999999999999",
    fee: 3000,
  };
  const wallet = "0xWallet3333";
  const filePath = eventCachePath(
    position,
    "pulsechain",
    config.POSITION_MANAGER,
    wallet,
  );
  const key = buildCacheKey(
    wallet,
    config.POSITION_MANAGER,
    position.token0,
    position.token1,
    position.fee,
  );
  // Written the way a scan writes it: a store of its own, whole.
  const writeAsScan = (value) =>
    createCacheStore({ filePath, defaultTtlMs: 60_000 }).set(key, value);

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* the case wrote nothing */
    }
  });

  it("lands after a running scan writes, not under it", async () => {
    /*-
     *  A scan writes back what it read when it started plus what it
     *  found. One that started before the rebalance mined and finishes
     *  after the append would write the cache back without it. Held to
     *  the pool's lock, the append waits for that write and adds to it.
     */
    const release = await getPoolScanLock(
      position.token0,
      position.token1,
      position.fee,
    ).acquire();
    const appended = appendToPoolCache(position, wallet, {
      oldTokenId: "400",
      newTokenId: "401",
      txHashes: ["0xhash4"],
      blockNumber: 5000,
    });
    // Long enough for an append that does not wait to finish.
    await new Promise((resolve) => setImmediate(resolve));
    await writeAsScan({ events: [], lastBlock: 4000, mintSchemaVersion: 2 });
    release();
    await appended;
    const cached = await readPoolCache(position, wallet);
    assert.ok(
      cached.events.some((e) => e.newTokenId === "401"),
      "the scan's write must not erase the appended rebalance",
    );
    /*-
     *  The scan read to block 4000 and the rebalance minted at 5000. The
     *  blocks between were never read, so the next scan must start after
     *  4000, not after 5000.
     */
    assert.equal(cached.lastBlock, 4000);
  });

  it("keeps what a scan stored beside the events", async () => {
    /*-
     *  A scan stores the chain's first mint beside its events. Lost, the
     *  next scan records the newest NFT as the chain's first, and the
     *  closed-position history falls back to walking the chain for it.
     */
    const scanned = {
      events: [],
      lastBlock: 7000,
      firstMintTimestamp: 1_760_000_000,
      firstMintBlockNumber: 6500,
      firstMintTokenId: "600",
      chainFirstTokenId: "590",
      chainFirstMintBlock: 6400,
      chainFirstMintTimestamp: 1_759_000_000,
      mintSchemaVersion: 2,
    };
    await writeAsScan(scanned);
    await appendToPoolCache(position, wallet, {
      oldTokenId: "600",
      newTokenId: "601",
      txHashes: ["0xhash6"],
      blockNumber: 7200,
    });
    const cached = await readPoolCache(position, wallet);
    for (const field of Object.keys(scanned).filter((k) => k !== "events"))
      assert.equal(cached[field], scanned[field], field);
    assert.equal(cached.events.length, 1);
    assert.equal(cached.events[0].blockNumber, 7200);
  });

  it("adds no second entry for a rebalance a scan already read", async () => {
    /*-
     *  A scan that held the lock first may have read the rebalance from
     *  the chain already, with a later block than this one: it read up
     *  to the head.
     */
    await writeAsScan({
      events: [
        {
          index: 1,
          timestamp: 1_771_200_000,
          oldTokenId: "500",
          newTokenId: "501",
          txHash: "0xhash5",
          blockNumber: 5000,
        },
      ],
      lastBlock: 9000,
      mintSchemaVersion: 2,
    });
    await appendToPoolCache(position, wallet, {
      oldTokenId: "500",
      newTokenId: "501",
      txHashes: ["0xremove5", "0xhash5"],
      blockNumber: 5000,
    });
    const cached = await readPoolCache(position, wallet);
    assert.equal(cached.events.length, 1);
    assert.equal(cached.lastBlock, 9000, "the last block read never goes back");
  });
});
