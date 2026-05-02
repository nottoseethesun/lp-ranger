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
  _fetchGeckoOhlcvAtTimeframe,
  _cache,
  _CACHE_TTL_MS,
} = require("../src/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
} = require("../src/gecko-rate-limit");

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
  _resetGeckoRateLimit();
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  _cache.clear();
  _resetGeckoRateLimit();
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

// 429-retry tests live in test/price-fetcher-429-retry.test.js to keep this
// file under the 500-line limit.

// ── GeckoTerminal OHLCV cascading timeframe fallback ────────────────────────

describe("GeckoTerminal OHLCV cascade (day → hour → minute)", () => {
  const POOL = "0xPoolAddress";
  const TS = 1712000000;

  /** Helper: build a mock that maps url timeframe → response body. */
  function mockByTimeframe(responses) {
    return async (url) => {
      const match = url.match(/\/ohlcv\/(day|hour|minute)/);
      const tf = match ? match[1] : "day";
      const body = responses[tf];
      if (!body) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    };
  }

  it("returns day-candle price when day has data (no cascade)", async () => {
    let dayCalls = 0;
    let otherCalls = 0;
    globalThis.fetch = async (url) => {
      if (url.includes("/ohlcv/day")) {
        dayCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              attributes: {
                ohlcv_list: [[TS, 0.1, 0.12, 0.09, 0.11, 50000]],
              },
            },
          }),
        };
      }
      otherCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const price = await _fetchGeckoTerminalOhlcv(POOL, TS);
    assert.strictEqual(price, 0.11);
    assert.strictEqual(dayCalls, 1, "day called once");
    assert.strictEqual(otherCalls, 0, "should not cascade when day succeeds");
  });

  it("cascades to hour when day returns empty", async () => {
    globalThis.fetch = mockByTimeframe({
      day: { data: { attributes: { ohlcv_list: [] } } },
      hour: {
        data: {
          attributes: {
            ohlcv_list: [[TS, 0.5, 0.6, 0.48, 0.55, 1000]],
          },
        },
      },
    });
    const price = await _fetchGeckoTerminalOhlcv(POOL, TS);
    assert.strictEqual(price, 0.55);
  });

  it("cascades to minute when day AND hour return empty", async () => {
    globalThis.fetch = mockByTimeframe({
      day: { data: { attributes: { ohlcv_list: [] } } },
      hour: { data: { attributes: { ohlcv_list: [] } } },
      minute: {
        data: {
          attributes: {
            ohlcv_list: [[TS, 0.01, 0.011, 0.009, 0.0105, 42]],
          },
        },
      },
    });
    const price = await _fetchGeckoTerminalOhlcv(POOL, TS);
    assert.strictEqual(price, 0.0105);
  });

  it("returns 0 when all three timeframes return empty", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
      };
    };
    const price = await _fetchGeckoTerminalOhlcv(POOL, TS);
    assert.strictEqual(price, 0);
    assert.strictEqual(calls, 3, "should try all 3 timeframes");
  });

  it("_fetchGeckoOhlcvAtTimeframe honors the requested timeframe in URL", async () => {
    let lastUrl = "";
    globalThis.fetch = async (url) => {
      lastUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
      };
    };
    await _fetchGeckoOhlcvAtTimeframe(POOL, TS, "base", "pulsechain", "hour");
    assert.ok(lastUrl.includes("/ohlcv/hour"), "should hit hour endpoint");
    await _fetchGeckoOhlcvAtTimeframe(POOL, TS, "base", "pulsechain", "minute");
    assert.ok(lastUrl.includes("/ohlcv/minute"), "should hit minute endpoint");
  });

  it("_fetchGeckoOhlcvAtTimeframe uses end-of-UTC-day as before_timestamp", async () => {
    let lastUrl = "";
    globalThis.fetch = async (url) => {
      lastUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
      };
    };
    // 2026-04-07 00:10:00 UTC — very early in the day.
    const blockTs = Math.floor(Date.UTC(2026, 3, 7, 0, 10, 0) / 1000);
    // End of the same UTC day = 2026-04-08 00:00:00 UTC.
    const expected = Math.floor(Date.UTC(2026, 3, 8, 0, 0, 0) / 1000);
    await _fetchGeckoOhlcvAtTimeframe(
      POOL,
      blockTs,
      "base",
      "pulsechain",
      "minute",
    );
    assert.ok(
      lastUrl.includes(`before_timestamp=${expected}`),
      `url should contain before_timestamp=${expected}, got: ${lastUrl}`,
    );
  });

  it("pool-inception case: returns latest minute candle from block's day", async () => {
    // Block near start of 2026-04-07 UTC (pool creation moment).
    const blockTs = Math.floor(Date.UTC(2026, 3, 7, 0, 5, 0) / 1000);
    // Latest minute candle: close_time = 23:58 UTC, close price = 0.00155
    const lateCandleTs = Math.floor(Date.UTC(2026, 3, 7, 23, 58, 0) / 1000);
    globalThis.fetch = async (url) => {
      // Day and hour return empty; minute returns the end-of-day candle.
      if (url.includes("/ohlcv/minute")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              attributes: {
                ohlcv_list: [
                  [lateCandleTs, 0.0015, 0.0016, 0.00149, 0.00155, 8.0],
                ],
              },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
      };
    };
    const price = await _fetchGeckoTerminalOhlcv(POOL, blockTs);
    assert.strictEqual(
      price,
      0.00155,
      "should return end-of-day minute candle close price",
    );
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

// ── Cascade logging ─────────────────────────────────────────────────────────

describe("Cascade logging", () => {
  let _origLog, _origWarn, captured;
  const { format } = require("node:util");

  function startCapture() {
    captured = [];
    _origLog = console.log;
    _origWarn = console.warn;
    console.log = (...a) => captured.push(format(...a));
    console.warn = (...a) => captured.push(format(...a));
  }
  function stopCapture() {
    console.log = _origLog;
    console.warn = _origWarn;
  }

  it("logs the source that succeeded and the abbreviated address", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      // Moralis branch is gated by API key (none in tests) → returns 0.
      // First real call is GeckoTerminal: return a valid price.
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              token_prices: { [TOKEN.toLowerCase()]: "0.42" },
            },
          },
        }),
      };
    };

    startCapture();
    try {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0.42);
    } finally {
      stopCapture();
    }
    // At least one log line should reference the abbreviated token address.
    const flat = captured.join("\n");
    const short = `${TOKEN.slice(0, 6)}\u2026${TOKEN.slice(-4)}`;
    assert.ok(
      flat.includes(short),
      `expected log to contain abbreviated address ${short}\n${flat}`,
    );
    assert.ok(
      flat.includes("GeckoTerminal ok") || flat.includes("DexScreener ok"),
      `expected an "ok" success line\n${flat}`,
    );
    assert.ok(calls >= 1, "should have hit at least one source");
  });

  it("logs miss for each failed source and final 'All sources failed'", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    startCapture();
    try {
      const price = await fetchTokenPriceUsd(TOKEN);
      assert.strictEqual(price, 0);
    } finally {
      stopCapture();
    }
    const flat = captured.join("\n");
    assert.ok(
      flat.includes("All sources failed"),
      `expected final failure summary\n${flat}`,
    );
  });
});
