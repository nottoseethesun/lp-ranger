"use strict";

/**
 * @file test/price-fetcher-orientation.test.js
 * @description A historical price is read from GeckoTerminal only once
 *   the pool's orientation is known.
 *
 *   GeckoTerminal's base and quote need not be a pool's token0 and
 *   token1, and for some pools they are the other way round. Reading the
 *   prices without knowing which would be right for most pools and swap
 *   the two for the rest — and a historical price is cached with no
 *   expiry, so a swapped one would stand until Re-scan Prices. When the
 *   orientation lookup fails, no GeckoTerminal price is taken and nothing
 *   is cached, so a later read asks again.
 *
 *   Both caches are redirected into a scratch directory before anything
 *   loads, so the operator's own are never touched.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const _DIR = fs.mkdtempSync(path.join(os.tmpdir(), "price-orientation-"));
process.env.PRICE_CACHE_PATH = path.join(_DIR, "historical-price-cache.json");
process.env.GECKO_POOL_CACHE_PATH = path.join(_DIR, "gecko-pool-cache.json");

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/lib/config");
const { fetchHistoricalPriceGecko } = require("../src/lib/price-fetcher");
const { getHistoricalPrice, _resetForTest } = require("../src/lib/price-cache");

const POOL = "0x" + "9".repeat(40);
const TOKEN0 = "0x" + "a".repeat(40);
const TOKEN1 = "0x" + "b".repeat(40);
const BLOCK = 4242;

let requests;
let poolInfo;
let realFetch;

/** A GeckoTerminal answer, in the shape `fetch` resolves to. */
const answer = (status, body) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

beforeEach(() => {
  _resetForTest();
  requests = [];
  realFetch = globalThis.fetch;
  /*-
   *  TEST-ONLY global swap: the orientation lookup and the OHLCV read are
   *  made with the global `fetch` by two different modules, and neither
   *  offers a seam for it. Restored pristine in `afterEach`, after each
   *  case's single call.
   */
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.includes("/ohlcv/"))
      return answer(200, {
        data: { attributes: { ohlcv_list: [[0, 1, 1, 1, 7, 1]] } },
      });
    return poolInfo();
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetForTest();
});

after(() => fs.rmSync(_DIR, { recursive: true, force: true }));

const read = () =>
  fetchHistoricalPriceGecko(POOL, 1_773_000_000, {
    token0Address: TOKEN0,
    token1Address: TOKEN1,
    blockNumber: BLOCK,
  });

describe("historical prices and the pool's orientation", () => {
  it("takes no price, and caches none, when the orientation cannot be learned", async () => {
    poolInfo = () => answer(500, {});
    const { price0, price1 } = await read();
    assert.strictEqual(price0, 0);
    assert.strictEqual(price1, 0);
    assert.ok(
      requests.every((u) => !u.includes("/ohlcv/")),
      "no candle is read for a pool whose orientation is unknown",
    );
    assert.strictEqual(
      getHistoricalPrice(config.CHAIN_NAME, TOKEN0, `@${BLOCK}`),
      null,
    );
  });

  it("reads and caches the prices once the orientation is known", async () => {
    const network = config.CHAIN.priceServices.geckoTerminalNetwork;
    poolInfo = () =>
      answer(200, {
        data: {
          relationships: {
            base_token: { data: { id: `${network}_${TOKEN0}` } },
          },
        },
      });
    const { price0, price1 } = await read();
    assert.strictEqual(price0, 7);
    assert.strictEqual(price1, 7);
    assert.strictEqual(
      getHistoricalPrice(config.CHAIN_NAME, TOKEN0, `@${BLOCK}`),
      7,
    );
  });
});
