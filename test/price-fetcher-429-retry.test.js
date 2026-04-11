/**
 * @file test/price-fetcher-429-retry.test.js
 * @description Tests for GeckoTerminal OHLCV 429 handling.
 *
 * GeckoTerminal enforces a server-side rate limit on top of our in-process
 * limiter. A 429 means "retry later", not "no data". Before the fix,
 * `_fetchGeckoOhlcvAtTimeframe` returned 0 on any non-2xx, so 429s were
 * silently treated as "no data" and callers fell through to current-price
 * fallback (skewing lifetime deposit USD).
 *
 * Fix behavior (tested here):
 *  1. On 429, retry with a bounded backoff schedule.
 *  2. On 429, signal the shared gecko-rate-limit so later callers cool down.
 *  3. Do NOT retry 2xx/empty or 4xx/5xx — only 429.
 *
 * Split into its own file so price-fetcher.test.js stays under the 500-line
 * cap.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  _fetchGeckoOhlcvAtTimeframe,
  _setOhlcv429Delays,
} = require("../src/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
  _getPenaltyUntilMs,
} = require("../src/gecko-rate-limit");

const POOL = "0x1234567890abcdef1234567890abcdef12345678";
const TS = 1700000000;

let _originalFetch;
let _origSetTimeout;

describe("GeckoTerminal OHLCV 429 retry", () => {
  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    _origSetTimeout = global.setTimeout;
    _resetGeckoRateLimit();
    _setOhlcv429Delays([1, 1]);
    // Stub setTimeout to pass-through with 0ms so tests run in ms not seconds.
    // (Same technique as gecko-pool-cache.test.js.)
    global.setTimeout = (fn, _ms) => _origSetTimeout(fn, 0);
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
    global.setTimeout = _origSetTimeout;
    _setOhlcv429Delays([3_000, 10_000]);
    _resetGeckoRateLimit();
  });

  it("retries once on 429 and returns the candle when the retry succeeds", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            attributes: {
              ohlcv_list: [[1700000000, 0.1, 0.12, 0.09, 0.11, 50000]],
            },
          },
        }),
      };
    };
    const price = await _fetchGeckoOhlcvAtTimeframe(
      POOL,
      TS,
      "base",
      "pulsechain",
      "day",
    );
    assert.strictEqual(price, 0.11, "should return the retry's close price");
    assert.strictEqual(calls, 2, "should fetch twice (original + 1 retry)");
  });

  it("gives up after exhausting the retry schedule on persistent 429s", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const price = await _fetchGeckoOhlcvAtTimeframe(
      POOL,
      TS,
      "base",
      "pulsechain",
      "day",
    );
    assert.strictEqual(price, 0, "should return 0 after exhausting retries");
    // 1 initial + 2 retries (delays array has 2 entries) = 3 total.
    assert.strictEqual(calls, 3, "should fetch initial + 2 retries = 3 times");
  });

  it("signals noteGecko429() to push the shared limiter window forward", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    const before = _getPenaltyUntilMs();
    await _fetchGeckoOhlcvAtTimeframe(POOL, TS, "base", "pulsechain", "day");
    const after = _getPenaltyUntilMs();
    assert.ok(
      after > before,
      `penalty timestamp should advance on 429 (before=${before}, after=${after})`,
    );
  });

  it("does NOT retry on 5xx (non-429 errors fall through immediately)", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const price = await _fetchGeckoOhlcvAtTimeframe(
      POOL,
      TS,
      "base",
      "pulsechain",
      "day",
    );
    assert.strictEqual(price, 0);
    assert.strictEqual(calls, 1, "should only fetch once for 5xx");
  });

  it("does NOT retry on HTTP 200 with empty ohlcv_list", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
      };
    };
    const price = await _fetchGeckoOhlcvAtTimeframe(
      POOL,
      TS,
      "base",
      "pulsechain",
      "day",
    );
    assert.strictEqual(price, 0);
    assert.strictEqual(
      calls,
      1,
      "empty candles is a real 'no data' — no retry",
    );
  });
});
