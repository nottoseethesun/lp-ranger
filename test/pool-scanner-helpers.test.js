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
  it("does not throw for valid position", async () => {
    // Just verifies it runs without error (cache file may not exist)
    await clearPoolCache(
      { token0: "0xAAAA0000", token1: "0xBBBB0000", fee: 500 },
      "0xWallet0000",
    );
  });
});

// ── appendToPoolCache ───────────────────────────────────────────────

describe("appendToPoolCache", () => {
  it("appends event with array txHashes", async () => {
    await appendToPoolCache(
      {
        token0: "0x2222222222222222222222222222222222222222",
        token1: "0x3333333333333333333333333333333333333333",
        fee: 3000,
      },
      "0xWallet1111",
      {
        oldTokenId: "100",
        newTokenId: "101",
        txHashes: ["0xhash1", "0xhash2"],
        blockNumber: 9999,
      },
    );
    // Should not throw — just verifies the cache write succeeds
  });

  it("handles missing txHashes gracefully", async () => {
    await appendToPoolCache(
      {
        token0: "0x4444444444444444444444444444444444444444",
        token1: "0x5555555555555555555555555555555555555555",
        fee: 500,
      },
      "0xWallet2222",
      {
        oldTokenId: "200",
        newTokenId: "201",
        blockNumber: 0,
      },
    );
  });
});
