/**
 * @file test/pool-scanner-helpers.test.js
 * @description Tests for getPoolScanLock and clearPoolCache in pool-scanner.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
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
      blockNumber: 0,
    });

    /*- "Gracefully" has to mean something observable: the event lands,
     *  and the absent hashes do not take the rest of it down with them. */
    const cached = await readPoolCache(position, "0xWallet2222");
    const ev = (cached?.events || []).find((e) => e.newTokenId === "201");
    assert.ok(ev, "an event without txHashes must still be stored");
    assert.equal(ev.oldTokenId, "200");
    assert.equal(ev.blockNumber, 0);
    /*- An empty string, not undefined: the dashboard renders this field
     *  and a missing one would print "undefined" in the events table. */
    assert.equal(ev.txHash, "");
  });
});
