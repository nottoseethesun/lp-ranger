/**
 * @file test/dust-unit-price.test.js
 * @description Tests for fetchDustUnitPriceUsd — alpha + fallback price
 *   sources listed in app-config/static-tunables/dust-threshold.json.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchDustUnitPriceUsd,
  _resetDustUnitPriceCache,
} = require("../src/price-fetcher");

let _origFetch;

/** Build a mock fetch that responds per-URL via a lookup map. */
function urlFetch(map) {
  return async (url) => {
    for (const [re, body] of map) {
      if (re.test(String(url))) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _resetDustUnitPriceCache();
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  _resetDustUnitPriceCache();
});

describe("fetchDustUnitPriceUsd", () => {
  it("returns alpha price source via DexScreener (no Moralis key)", async () => {
    // First token in dust-threshold.json is the alpha — its price wins.
    globalThis.fetch = urlFetch([
      [
        /dexscreener.*0x45804880De22913dAFE09f4980848ECE6EcbAf78/i,
        {
          pairs: [
            {
              chainId: "ethereum",
              priceUsd: "4800.00",
              liquidity: { usd: 1e6 },
            },
          ],
        },
      ],
    ]);
    const price = await fetchDustUnitPriceUsd();
    assert.ok(price > 0, `expected > 0, got ${price}`);
    assert.ok(Math.abs(price - 4800) < 1, `expected ~4800, got ${price}`);
  });

  it("falls back to the second source when the alpha fails", async () => {
    globalThis.fetch = urlFetch([
      [/0x45804880De22913dAFE09f4980848ECE6EcbAf78/i, { pairs: [] }],
      [
        /0x68749665FF8D2d112Fa859AA293F07A622782F38/i,
        {
          pairs: [
            {
              chainId: "ethereum",
              priceUsd: "4801.50",
              liquidity: { usd: 1e6 },
            },
          ],
        },
      ],
    ]);
    const price = await fetchDustUnitPriceUsd();
    assert.ok(Math.abs(price - 4801.5) < 1, `expected ~4801.5, got ${price}`);
  });

  it("returns 0 when all sources fail", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const price = await fetchDustUnitPriceUsd();
    assert.strictEqual(price, 0);
  });

  it("caches the result within TTL", async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (/0x45804880De22913dAFE09f4980848ECE6EcbAf78/i.test(String(url))) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pairs: [
              {
                chainId: "ethereum",
                priceUsd: "4800",
                liquidity: { usd: 1e6 },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const p1 = await fetchDustUnitPriceUsd();
    const callsAfterFirst = calls;
    const p2 = await fetchDustUnitPriceUsd();
    assert.strictEqual(p1, p2);
    assert.strictEqual(calls, callsAfterFirst, "second call should be cached");
  });
});
