"use strict";

/**
 * @file test/price-fetcher-moralis-block.test.js
 * @description Which service prices a past moment while a Moralis key is
 *   saved. Asked at a block, Moralis prices each coin at that block, and
 *   GeckoTerminal, whose figure is the day's, is not asked. Asked with no
 *   block, Moralis is not asked at all, since it prices only by block.
 *   The rebuilt compound list relies on the first: it passes each
 *   compound's deposit block (`compoundPricesFor`,
 *   src/lib/compound-activity-figures.js).
 *
 *   Under `node --test` the price caches are this process's own
 *   (src/lib/scan-cache-dir.js), so the operator's are never touched.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/lib/config");
const { fetchHistoricalPriceGecko } = require("../src/lib/price-fetcher");
const { getHistoricalPrice, _resetForTest } = require("../src/lib/price-cache");
const { setApiKey } = require("../src/lib/api-key-holder");

const POOL = "0x" + "9".repeat(40);
const TOKEN0 = "0x" + "a".repeat(40);
const TOKEN1 = "0x" + "b".repeat(40);
const BLOCK = 4242;
const WHEN = 1_773_000_000;

/** What Moralis answers for each coin. */
const MORALIS_PRICES = { [TOKEN0]: 3, [TOKEN1]: 0.5 };

let requests;
let realFetch;

/** An answer in the shape `fetch` resolves to. */
const answer = (status, body) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

/** The coin a Moralis price request asks about, or undefined. */
const moralisCoin = (url) =>
  Object.keys(MORALIS_PRICES).find((t) => url.includes(`/erc20/${t}/price`));

beforeEach(() => {
  _resetForTest();
  requests = [];
  setApiKey("moralis", "test-key");
  realFetch = globalThis.fetch;
  /*-
   *  TEST-ONLY global swap: Moralis and GeckoTerminal are asked with the
   *  global `fetch`, and the price modules offer no seam for it.
   *  Restored pristine in `afterEach`, after each case's single call.
   */
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const coin = moralisCoin(String(url));
    if (coin === undefined) return answer(500, {});
    return answer(200, { usdPrice: MORALIS_PRICES[coin] });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setApiKey("moralis", null);
  _resetForTest();
});

describe("historical prices while a Moralis key is saved", () => {
  it("are Moralis's at the block asked for, with GeckoTerminal not asked", async () => {
    const got = await fetchHistoricalPriceGecko(POOL, WHEN, {
      token0Address: TOKEN0,
      token1Address: TOKEN1,
      blockNumber: BLOCK,
    });
    assert.deepEqual(got, { price0: 3, price1: 0.5 });
    assert.equal(requests.length, 2, "one Moralis request per coin");
    const moralisChain = config.CHAIN.priceServices.moralisChain;
    for (const url of requests) {
      assert.ok(moralisCoin(url) !== undefined, `not Moralis: ${url}`);
      const query = new URL(url).searchParams;
      assert.equal(query.get("to_block"), String(BLOCK));
      assert.equal(query.get("chain"), moralisChain);
    }
    assert.equal(getHistoricalPrice(config.CHAIN_NAME, TOKEN0, `@${BLOCK}`), 3);
    assert.equal(
      getHistoricalPrice(config.CHAIN_NAME, TOKEN1, `@${BLOCK}`),
      0.5,
    );
  });

  it("never ask Moralis without a block, which it prices by", async () => {
    await fetchHistoricalPriceGecko(POOL, WHEN, {
      token0Address: TOKEN0,
      token1Address: TOKEN1,
    });
    assert.ok(requests.length > 0, "GeckoTerminal was asked");
    assert.ok(
      requests.every((url) => moralisCoin(url) === undefined),
      "no Moralis request",
    );
  });
});
