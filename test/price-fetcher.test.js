/**
 * @file test/price-fetcher.test.js
 * @description Unit tests for the price-fetcher module.
 * Run with: node --test test/price-fetcher.test.js
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchTokenPriceUsd,
  fetchHistoricalPriceGecko,
  _fetchDexScreener,
  _fetchGeckoTerminalOhlcv,
  _cache,
  _CACHE_TTL_MS,
} = require("../src/price-fetcher");

// ── helpers ──────────────────────────────────────────────────────────────────

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

/** Save and restore the real global fetch around every test. */
let _originalFetch;

/**
 * Build a mock fetch that returns the given JSON body.
 * @param {object} body   - Response body.
 * @param {number} [status=200] - HTTP status code.
 * @returns {Function} A mock fetch function.
 */
function mockFetch(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/**
 * Build a mock fetch that rejects with an error.
 * @param {string} message - Error message.
 * @returns {Function} A mock fetch function.
 */
function _mockFetchError(message) {
  return async () => {
    throw new Error(message);
  };
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _cache.clear();
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  _cache.clear();
});

// ── DexScreener success ──────────────────────────────────────────────────────

describe("DexScreener success", () => {
  it("returns priceUsd from highest-liquidity PulseChain pair", async () => {
    globalThis.fetch = mockFetch({
      pairs: [
        {
          chainId: "pulsechain",
          priceUsd: "0.50",
          liquidity: { usd: 1000 },
        },
        {
          chainId: "pulsechain",
          priceUsd: "0.55",
          liquidity: { usd: 50000 },
        },
        {
          chainId: "ethereum",
          priceUsd: "9.99",
          liquidity: { usd: 999999 },
        },
      ],
    });

    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(
      price,
      0.55,
      "should pick the highest-liquidity PulseChain pair",
    );
  });

  it("returns price from _fetchDexScreener directly", async () => {
    globalThis.fetch = mockFetch({
      pairs: [
        {
          chainId: "pulsechain",
          priceUsd: "1.23",
          liquidity: { usd: 5000 },
        },
      ],
    });

    const price = await _fetchDexScreener(TOKEN, "pulsechain");
    assert.strictEqual(price, 1.23);
  });
});

// ── GeckoTerminal → DexScreener fallback ─────────────────────────────────────

describe("GeckoTerminal fails, DexScreener succeeds", () => {
  it("falls through to DexScreener when GeckoTerminal returns no price", async () => {
    let callCount = 0;

    globalThis.fetch = async (_url, _opts) => {
      callCount += 1;

      // First call: GeckoTerminal — no token_prices.
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({ data: { attributes: {} } }),
        };
      }

      // Second call: DexScreener — valid price.
      return {
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: "pulsechain",
              priceUsd: "2.34",
              liquidity: { usd: 50000 },
            },
          ],
        }),
      };
    };

    const price = await fetchTokenPriceUsd(TOKEN);

    assert.strictEqual(price, 2.34, "should fall through to DexScreener");
    assert.strictEqual(callCount, 2, "should have made two fetch calls");
  });
});

// ── Both fail ────────────────────────────────────────────────────────────────

describe("Both fail", () => {
  it("returns 0 when both GeckoTerminal and DexScreener fail", async () => {
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount += 1;
      throw new Error(`network error ${callCount}`);
    };

    const price = await fetchTokenPriceUsd(TOKEN);

    assert.strictEqual(price, 0, "should return 0 when all sources fail");
    assert.strictEqual(callCount, 2, "should have attempted both sources");
  });

  it("returns 0 when both return no usable data", async () => {
    globalThis.fetch = mockFetch({ data: { attributes: {} } });

    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0);
  });
});

// ── Cache hit ────────────────────────────────────────────────────────────────

describe("Cache hit", () => {
  it("second call returns cached value without fetch", async () => {
    let fetchCallCount = 0;

    globalThis.fetch = async (_url, _opts) => {
      fetchCallCount += 1;
      // GeckoTerminal returns a valid price on first call.
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              token_prices: { [TOKEN.toLowerCase()]: "1.11" },
            },
          },
        }),
      };
    };

    const price1 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price1, 1.11);
    assert.strictEqual(fetchCallCount, 1);

    const price2 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price2, 1.11, "should return cached value");
    assert.strictEqual(fetchCallCount, 1, "should not have called fetch again");
  });

  it("cache key is case-insensitive on token address", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            token_prices: { [TOKEN.toLowerCase()]: "2.22" },
          },
        },
      }),
    });

    await fetchTokenPriceUsd(TOKEN.toLowerCase());
    const price = await fetchTokenPriceUsd(TOKEN.toUpperCase());
    assert.strictEqual(price, 2.22, "should hit cache regardless of case");
  });
});

// ── Cache expiry ─────────────────────────────────────────────────────────────

describe("Cache expiry", () => {
  it("after TTL, fetches again", async () => {
    let fetchCallCount = 0;
    const prices = ["1.00", "2.00"];

    globalThis.fetch = async () => {
      const p = prices[fetchCallCount] || "0";
      fetchCallCount += 1;
      // GeckoTerminal-shaped response (primary oracle).
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              token_prices: { [TOKEN.toLowerCase()]: p },
            },
          },
        }),
      };
    };

    const price1 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price1, 1.0);
    assert.strictEqual(fetchCallCount, 1);

    // Manually expire the cache entry by backdating its timestamp.
    const key = `pulsechain:${TOKEN.toLowerCase()}`;
    const entry = _cache.get(key);
    entry.ts = Date.now() - _CACHE_TTL_MS - 1;

    const price2 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price2, 2.0, "should fetch fresh price after TTL");
    assert.strictEqual(fetchCallCount, 2, "should have made a second fetch");
  });

  it("_CACHE_TTL_MS is 60000", () => {
    assert.strictEqual(_CACHE_TTL_MS, 60_000);
  });
});

// ── GeckoTerminal OHLCV ─────────────────────────────────────────────────────

const POOL = "0x1234567890abcdef1234567890abcdef12345678";
const TIMESTAMP = 1700000000;

describe("GeckoTerminal _fetchGeckoTerminalOhlcv", () => {
  it("returns close price from a valid OHLCV candle", async () => {
    globalThis.fetch = mockFetch({
      data: {
        attributes: {
          ohlcv_list: [[1700000000, 0.1, 0.12, 0.09, 0.11, 50000]],
        },
      },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0.11, "should return close price (index 4)");
  });

  it("returns 0 on HTTP error", async () => {
    globalThis.fetch = mockFetch({}, 500);

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it("returns 0 when ohlcv_list is empty", async () => {
    globalThis.fetch = mockFetch({
      data: { attributes: { ohlcv_list: [] } },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it("returns 0 when response has no attributes", async () => {
    globalThis.fetch = mockFetch({ data: {} });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it("returns 0 on network error", async () => {
    globalThis.fetch = _mockFetchError("network timeout");

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it("returns 0 when close price is NaN", async () => {
    globalThis.fetch = mockFetch({
      data: {
        attributes: {
          ohlcv_list: [[1700000000, 0.1, 0.12, 0.09, "bad", 50000]],
        },
      },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });
});

describe("GeckoTerminal fetchHistoricalPriceGecko", () => {
  it("returns both base and quote prices", async () => {
    let callIndex = 0;
    const candles = [
      [[1700000000, 0.1, 0.12, 0.09, 0.5, 1000]],
      [[1700000000, 1.0, 1.05, 0.95, 1.02, 2000]],
    ];

    globalThis.fetch = async () => {
      const ohlcv = candles[callIndex] || [];
      callIndex += 1;
      return {
        ok: true,
        json: async () => ({
          data: { attributes: { ohlcv_list: ohlcv } },
        }),
      };
    };

    const { price0, price1 } = await fetchHistoricalPriceGecko(POOL, TIMESTAMP);
    assert.strictEqual(price0, 0.5, "base token price");
    assert.strictEqual(price1, 1.02, "quote token price");
  });

  it("returns zeros when both calls fail", async () => {
    globalThis.fetch = _mockFetchError("server down");

    const { price0, price1 } = await fetchHistoricalPriceGecko(POOL, TIMESTAMP);
    assert.strictEqual(price0, 0);
    assert.strictEqual(price1, 0);
  });
});
