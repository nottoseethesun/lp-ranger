/**
 * @file test/price-fetcher-refresh.test.js
 * @description The `refresh` option on `fetchHistoricalPriceGecko`.
 *
 * A historical price never changes, so the disk cache has no expiry. That
 * also means a bad entry stays until something reads past it, which is
 * what Re-scan Prices asks for. Without the option the cached value is
 * returned and no source is called at all.
 *
 * The cache path is redirected before the modules load, so the operator's
 * real price cache is never touched.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
// CRITICAL: redirect the cache path BEFORE requiring the module, so this
// can never touch the operator's own price cache. Scoped by pid, as
// test/price-cache.test.js is, so parallel files cannot collide.
process.env.PRICE_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-price-cache-refresh-${process.pid}.json`,
);

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { fetchHistoricalPriceGecko } = require("../src/price-fetcher");
const { setHistoricalPrice, _resetForTest } = require("../src/price-cache");

const POOL = "0xPOOL";
const TOKEN0 = "0xA";
const TOKEN1 = "0xB";
const BLOCK = 4242;
const CHAIN = "pulsechain";

let _originalFetch;
let calls;

beforeEach(() => {
  _resetForTest();
  calls = 0;
  _originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("no source reachable");
  };
  // The bad prices a user runs Re-scan Prices to be rid of.
  setHistoricalPrice(CHAIN, TOKEN0, `@${BLOCK}`, 0.0001);
  setHistoricalPrice(CHAIN, TOKEN1, `@${BLOCK}`, 9999);
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  _resetForTest();
});

after(() => {
  try {
    fs.unlinkSync(process.env.PRICE_CACHE_PATH);
  } catch {
    /* the file is only written when a test flushes the cache */
  }
});

const fetchPrices = (refresh) =>
  fetchHistoricalPriceGecko(POOL, 1_773_000_000, CHAIN, {
    token0Address: TOKEN0,
    token1Address: TOKEN1,
    blockNumber: BLOCK,
    refresh,
  });

describe("fetchHistoricalPriceGecko — refresh", () => {
  it("returns the cached price without asking any source", async () => {
    const { price0, price1 } = await fetchPrices(undefined);
    assert.strictEqual(price0, 0.0001);
    assert.strictEqual(price1, 9999);
    assert.strictEqual(calls, 0, "the cache answered");
  });

  it("asks the sources again when refresh is set", async () => {
    const { price0, price1 } = await fetchPrices(true);
    assert.ok(calls > 0, "the cache must not answer a refresh");
    assert.strictEqual(price0, 0, "the cached figure is not reused");
    assert.strictEqual(price1, 0);
  });

  it("leaves the cached price in place when no source answers", async () => {
    await fetchPrices(true);
    const { price0, price1 } = await fetchPrices(undefined);
    assert.strictEqual(price0, 0.0001, "a failed refresh destroys nothing");
    assert.strictEqual(price1, 9999);
  });
});
