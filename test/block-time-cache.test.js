/**
 * @file test/block-time-cache.test.js
 * @description Tests for the block-number → timestamp disk cache.
 */

"use strict";

const path = require("path");
const fs = require("fs");

// CRITICAL: redirect cache path BEFORE requiring the module, so the test can
// never clobber the production cache file regardless of how it is invoked.
process.env.BLOCK_TIME_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-block-time-cache-${process.pid}.json`,
);

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  getBlockTimestamp,
  flushBlockTimeCache,
  _resetForTest,
  _CACHE_PATH,
} = require("../src/lib/block-time-cache");

describe("block-time-cache", () => {
  after(() => {
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
  });
  beforeEach(() => {
    _resetForTest();
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    _resetForTest();
  });

  it("fetches and caches a block timestamp", async () => {
    let calls = 0;
    const fakeProvider = {
      getBlock: async (block) => {
        calls++;
        return { timestamp: 1234567890 + block };
      },
    };
    const ts1 = await getBlockTimestamp(fakeProvider, "pulsechain", 100);
    const ts2 = await getBlockTimestamp(fakeProvider, "pulsechain", 100);
    assert.equal(ts1, 1234567990);
    assert.equal(ts2, 1234567990);
    assert.equal(calls, 1, "second call should hit cache");
  });

  it("isolates cache by blockchain", async () => {
    const provider = {
      getBlock: async (b) => ({ timestamp: 1000 + b }),
    };
    const a = await getBlockTimestamp(provider, "pulsechain", 5);
    const b = await getBlockTimestamp(provider, "ethereum", 5);
    assert.equal(a, 1005);
    assert.equal(b, 1005);
    // Different keys, both cached
    flushBlockTimeCache();
    const reloaded = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
    assert.equal(reloaded["pulsechain-5"], 1005);
    assert.equal(reloaded["ethereum-5"], 1005);
  });

  it("returns 0 when provider getBlock throws", async () => {
    const provider = {
      getBlock: async () => {
        throw new Error("RPC down");
      },
    };
    const ts = await getBlockTimestamp(provider, "pulsechain", 1);
    assert.equal(ts, 0);
  });

  it("returns 0 when provider returns no timestamp", async () => {
    const provider = { getBlock: async () => null };
    const ts = await getBlockTimestamp(provider, "pulsechain", 1);
    assert.equal(ts, 0);
  });

  it("flush is a no-op when not dirty", () => {
    flushBlockTimeCache();
    assert.equal(fs.existsSync(_CACHE_PATH), false);
  });

  it("flush persists cache and survives reload", async () => {
    const provider = { getBlock: async () => ({ timestamp: 999 }) };
    await getBlockTimestamp(provider, "pulsechain", 42);
    flushBlockTimeCache();
    _resetForTest();
    // Reload from disk via a fresh getBlockTimestamp call. Provider should
    // not be hit because the cached value is loaded.
    let called = false;
    const trackingProvider = {
      getBlock: async () => {
        called = true;
        return { timestamp: 0 };
      },
    };
    const ts = await getBlockTimestamp(trackingProvider, "pulsechain", 42);
    assert.equal(ts, 999);
    assert.equal(called, false);
  });
});
