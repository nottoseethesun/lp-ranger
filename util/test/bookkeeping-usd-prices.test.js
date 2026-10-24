"use strict";

/**
 * @file util/test/bookkeeping-usd-prices.test.js
 * @description
 * Tests for the bookkeeping tools' wrapper of LP Ranger's price library
 * (`util/bookkeeping/usd-prices.js`): where it points the library's caches
 * before the library loads, and how it turns the library's answer into a
 * price or a stop. Every lookup goes to a stand-in for the library, so no
 * case asks Moralis or CoinGecko.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { scanCachePath } = require("../../src/lib/scan-cache-dir");
const {
  CACHE_DIR,
  PRICE_ADVICE,
  cachePath,
  utcDay,
  usdPriceOn,
} = require("../bookkeeping/usd-prices");

const COIN = "0x3333333333333333333333333333333333333333";
/** 2026-10-19 12:00:00 UTC. */
const NOON = Date.UTC(2026, 9, 19, 12) / 1000;
/** A transaction's block at noon, and the moment it names. */
const BLOCK = 26_400_000;
const MOMENT = { timestamp: NOON, blockNumber: BLOCK };

test("the library's caches go to the test's own folder under node --test", () => {
  assert.equal(
    process.env.PRICE_CACHE_PATH,
    scanCachePath("historical-price-cache.json"),
  );
  assert.equal(
    process.env.GECKO_POOL_CACHE_PATH,
    scanCachePath("gecko-pool-cache.json"),
  );
});

test("outside a test, the caches go to the bookkeeping tools' own folder", () => {
  assert.equal(
    CACHE_DIR,
    path.resolve(__dirname, "../../app-data/util/bookkeeping/scan-cache"),
  );
  /*-
   *  process.env is changed, not a JS global, and put back in the
   *  `finally`, immediately after the call that needed it.
   */
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(cachePath("a.json"), path.join(CACHE_DIR, "a.json"));
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
});

test("utcDay names the UTC day of a moment", () => {
  assert.equal(utcDay(NOON), "2026-10-19");
  assert.equal(utcDay(Date.UTC(2026, 9, 19, 23, 59, 59) / 1000), "2026-10-19");
});

test("usdPriceOn asks the library by coin, moment and block, so Moralis is asked first", async () => {
  const asked = [];
  const price = await usdPriceOn(COIN, MOMENT, async (coin, opts) => {
    asked.push([coin, opts]);
    return 1.25;
  });
  assert.equal(price, 1.25);
  assert.deepEqual(asked, [[COIN, { timestamp: NOON, blockNumber: BLOCK }]]);
});

test("usdPriceOn refuses an answer that is not a price, naming the coin, block and day", async () => {
  for (const answer of [0, -1, Number.NaN, Infinity, "2", undefined]) {
    await assert.rejects(
      usdPriceOn(COIN, MOMENT, async () => answer),
      (error) => {
        assert.equal(error.priceUnavailable, true);
        assert.equal(
          error.message,
          "Neither Moralis nor CoinGecko (GeckoTerminal) gave a USD price " +
            `for ${COIN} at block ${BLOCK}, on 2026-10-19 (UTC)`,
        );
        return true;
      },
      String(answer),
    );
  }
});

test("usdPriceOn marks a lookup that throws as the price oracle's failure", async () => {
  await assert.rejects(
    usdPriceOn(COIN, MOMENT, async () => {
      throw new Error("fetch failed");
    }),
    { message: "fetch failed", priceUnavailable: true },
  );
  await assert.rejects(
    usdPriceOn(COIN, MOMENT, async () => {
      throw "rate limited";
    }),
    { message: "rate limited", priceUnavailable: true },
  );
});

test("the advice names both oracles asked and suggests another", () => {
  assert.match(
    PRICE_ADVICE,
    /Moralis and then CoinGecko through GeckoTerminal/,
  );
  assert.match(PRICE_ADVICE, /Consider trying a different price oracle/);
  assert.match(PRICE_ADVICE, /an older day's price must come from Moralis/);
});
