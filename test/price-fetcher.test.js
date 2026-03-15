/**
 * @file test/price-fetcher.test.js
 * @description Unit tests for the price-fetcher module.
 * Run with: node --test test/price-fetcher.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchTokenPriceUsd,
  fetchHistoricalPriceGecko,
  _fetchDexScreener,
  _fetchDexTools,
  _fetchGeckoTerminalOhlcv,
  _cache,
  _CACHE_TTL_MS,
} = require('../src/price-fetcher');

// ── helpers ──────────────────────────────────────────────────────────────────

const TOKEN = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

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

describe('DexScreener success', () => {
  it('returns priceUsd from highest-liquidity PulseChain pair', async () => {
    globalThis.fetch = mockFetch({
      pairs: [
        {
          chainId: 'pulsechain',
          priceUsd: '0.50',
          liquidity: { usd: 1000 },
        },
        {
          chainId: 'pulsechain',
          priceUsd: '0.55',
          liquidity: { usd: 50000 },
        },
        {
          chainId: 'ethereum',
          priceUsd: '9.99',
          liquidity: { usd: 999999 },
        },
      ],
    });

    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0.55, 'should pick the highest-liquidity PulseChain pair');
  });

  it('returns price from _fetchDexScreener directly', async () => {
    globalThis.fetch = mockFetch({
      pairs: [
        {
          chainId: 'pulsechain',
          priceUsd: '1.23',
          liquidity: { usd: 5000 },
        },
      ],
    });

    const price = await _fetchDexScreener(TOKEN, 'pulsechain');
    assert.strictEqual(price, 1.23);
  });
});

// ── DexScreener no PulseChain pairs ──────────────────────────────────────────

describe('DexScreener no PulseChain pairs', () => {
  it('falls through to DexTools when DexScreener has no matching chain pairs', async () => {
    let callCount = 0;

    globalThis.fetch = async (_url, _opts) => {
      callCount += 1;

      // First call: DexScreener — return only ethereum pairs.
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            pairs: [
              {
                chainId: 'ethereum',
                priceUsd: '9.99',
                liquidity: { usd: 100000 },
              },
            ],
          }),
        };
      }

      // Second call: DexTools — return a valid price.
      return {
        ok: true,
        json: async () => ({
          data: { price: 2.34 },
        }),
      };
    };

    const price = await fetchTokenPriceUsd(TOKEN, {
      dextoolsApiKey: 'test-key',
    });

    assert.strictEqual(price, 2.34, 'should fall through to DexTools');
    assert.strictEqual(callCount, 2, 'should have made two fetch calls');
  });
});

// ── DexTools success ─────────────────────────────────────────────────────────

describe('DexTools success', () => {
  it('returns price when DexScreener fails with HTTP error', async () => {
    let callCount = 0;

    globalThis.fetch = async (_url, _opts) => {
      callCount += 1;

      // First call: DexScreener — 500 error.
      if (callCount === 1) {
        return { ok: false, status: 500, json: async () => ({}) };
      }

      // Second call: DexTools — valid response.
      return {
        ok: true,
        json: async () => ({ data: { priceUsd: 3.45 } }),
      };
    };

    const price = await fetchTokenPriceUsd(TOKEN, {
      dextoolsApiKey: 'test-key',
    });

    assert.strictEqual(price, 3.45, 'should return DexTools price');
  });

  it('returns price via _fetchDexTools directly', async () => {
    globalThis.fetch = mockFetch({ data: { price: 7.89 } });

    const price = await _fetchDexTools(TOKEN, 'my-api-key', 'pulsechain');
    assert.strictEqual(price, 7.89);
  });

  it('handles priceUsd field in DexTools response', async () => {
    globalThis.fetch = mockFetch({ data: { priceUsd: 4.56 } });

    const price = await _fetchDexTools(TOKEN, 'my-api-key');
    assert.strictEqual(price, 4.56);
  });

  it('returns 0 when DexTools returns non-ok response', async () => {
    globalThis.fetch = mockFetch({}, 401);

    const price = await _fetchDexTools(TOKEN, 'bad-key');
    assert.strictEqual(price, 0);
  });
});

// ── Both fail ────────────────────────────────────────────────────────────────

describe('Both fail', () => {
  it('returns 0 when both DexScreener and DexTools fail', async () => {
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount += 1;
      throw new Error(`network error ${callCount}`);
    };

    const price = await fetchTokenPriceUsd(TOKEN, {
      dextoolsApiKey: 'test-key',
    });

    assert.strictEqual(price, 0, 'should return 0 when all sources fail');
    assert.strictEqual(callCount, 2, 'should have attempted both sources');
  });

  it('returns 0 when DexScreener returns empty pairs and no DexTools key', async () => {
    globalThis.fetch = mockFetch({ pairs: [] });

    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0);
  });

  it('returns 0 when DexScreener returns null pairs', async () => {
    globalThis.fetch = mockFetch({ pairs: null });

    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0);
  });
});

// ── Cache hit ────────────────────────────────────────────────────────────────

describe('Cache hit', () => {
  it('second call returns cached value without fetch', async () => {
    let fetchCallCount = 0;

    globalThis.fetch = async (_url, _opts) => {
      fetchCallCount += 1;
      return {
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: 'pulsechain',
              priceUsd: '1.11',
              liquidity: { usd: 1000 },
            },
          ],
        }),
      };
    };

    const price1 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price1, 1.11);
    assert.strictEqual(fetchCallCount, 1);

    const price2 = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price2, 1.11, 'should return cached value');
    assert.strictEqual(fetchCallCount, 1, 'should not have called fetch again');
  });

  it('cache key is case-insensitive on token address', async () => {
    globalThis.fetch = mockFetch({
      pairs: [
        {
          chainId: 'pulsechain',
          priceUsd: '2.22',
          liquidity: { usd: 500 },
        },
      ],
    });

    await fetchTokenPriceUsd(TOKEN.toLowerCase());
    const price = await fetchTokenPriceUsd(TOKEN.toUpperCase());
    assert.strictEqual(price, 2.22, 'should hit cache regardless of case');
  });
});

// ── Cache expiry ─────────────────────────────────────────────────────────────

describe('Cache expiry', () => {
  it('after TTL, fetches again', async () => {
    let fetchCallCount = 0;
    const prices = ['1.00', '2.00'];

    globalThis.fetch = async () => {
      const priceUsd = prices[fetchCallCount] || '0';
      fetchCallCount += 1;
      return {
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: 'pulsechain',
              priceUsd,
              liquidity: { usd: 1000 },
            },
          ],
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
    assert.strictEqual(price2, 2.0, 'should fetch fresh price after TTL');
    assert.strictEqual(fetchCallCount, 2, 'should have made a second fetch');
  });

  it('_CACHE_TTL_MS is 60000', () => {
    assert.strictEqual(_CACHE_TTL_MS, 60_000);
  });
});

// ── No DexTools key ──────────────────────────────────────────────────────────

describe('No DexTools key', () => {
  it('skips DexTools fallback entirely when no API key is provided', async () => {
    let fetchCallCount = 0;

    globalThis.fetch = async () => {
      fetchCallCount += 1;
      // DexScreener returns no pairs.
      return {
        ok: true,
        json: async () => ({ pairs: [] }),
      };
    };

    const price = await fetchTokenPriceUsd(TOKEN);

    assert.strictEqual(price, 0, 'should return 0');
    assert.strictEqual(fetchCallCount, 1, 'should only call DexScreener, not DexTools');
  });

  it('skips DexTools when dextoolsApiKey is explicitly null', async () => {
    let fetchCallCount = 0;

    globalThis.fetch = async () => {
      fetchCallCount += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const price = await fetchTokenPriceUsd(TOKEN, { dextoolsApiKey: null });

    assert.strictEqual(price, 0);
    assert.strictEqual(fetchCallCount, 1, 'only DexScreener attempted');
  });
});

// ── GeckoTerminal OHLCV ─────────────────────────────────────────────────────

const POOL = '0x1234567890abcdef1234567890abcdef12345678';
const TIMESTAMP = 1700000000;

describe('GeckoTerminal _fetchGeckoTerminalOhlcv', () => {
  it('returns close price from a valid OHLCV candle', async () => {
    globalThis.fetch = mockFetch({
      data: {
        attributes: {
          ohlcv_list: [[1700000000, 0.10, 0.12, 0.09, 0.11, 50000]],
        },
      },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0.11, 'should return close price (index 4)');
  });

  it('returns 0 on HTTP error', async () => {
    globalThis.fetch = mockFetch({}, 500);

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it('returns 0 when ohlcv_list is empty', async () => {
    globalThis.fetch = mockFetch({
      data: { attributes: { ohlcv_list: [] } },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it('returns 0 when response has no attributes', async () => {
    globalThis.fetch = mockFetch({ data: {} });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it('returns 0 on network error', async () => {
    globalThis.fetch = _mockFetchError('network timeout');

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });

  it('returns 0 when close price is NaN', async () => {
    globalThis.fetch = mockFetch({
      data: {
        attributes: {
          ohlcv_list: [[1700000000, 0.10, 0.12, 0.09, 'bad', 50000]],
        },
      },
    });

    const price = await _fetchGeckoTerminalOhlcv(POOL, TIMESTAMP);
    assert.strictEqual(price, 0);
  });
});

describe('GeckoTerminal fetchHistoricalPriceGecko', () => {
  it('returns both base and quote prices', async () => {
    let callIndex = 0;
    const candles = [
      [[1700000000, 0.10, 0.12, 0.09, 0.50, 1000]],
      [[1700000000, 1.00, 1.05, 0.95, 1.02, 2000]],
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
    assert.strictEqual(price0, 0.50, 'base token price');
    assert.strictEqual(price1, 1.02, 'quote token price');
  });

  it('returns zeros when both calls fail', async () => {
    globalThis.fetch = _mockFetchError('server down');

    const { price0, price1 } = await fetchHistoricalPriceGecko(POOL, TIMESTAMP);
    assert.strictEqual(price0, 0);
    assert.strictEqual(price1, 0);
  });
});
