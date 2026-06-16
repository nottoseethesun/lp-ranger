/**
 * @file test/price-fetcher-dedup.test.js
 * @description Unit tests for the in-flight fetch dedup in
 *   `src/price-fetcher-dedup.js`.  When N callers race past the cache
 *   for the same token in the same tick, only the first should hit the
 *   source cascade — the rest must await the same Promise.  This
 *   eliminates the thundering-herd that otherwise wastes price-source
 *   quota and produces N duplicate `[price-fetcher] X ok …` log lines.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchTokenPriceUsd,
  withFreshPricesAllowed,
  _resetPauseStateForTests,
  _cache,
} = require("../src/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
} = require("../src/gecko-rate-limit");
const {
  _resetInflightForTests,
  _inflightSize,
} = require("../src/price-fetcher-dedup");

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const TOKEN_B = "0x1111111111111111111111111111111111111111";

let _origFetch;

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _cache.clear();
  _resetPauseStateForTests();
  _resetGeckoRateLimit();
  _resetInflightForTests();
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  _cache.clear();
  _resetPauseStateForTests();
  _resetGeckoRateLimit();
  _resetInflightForTests();
});

/** Build a fetch stub that records every URL and returns `priceFn(url)`. */
function _stubFetch(priceFn) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    /*- Yield once so concurrent callers can pile in before resolution.
     *  Without this the first call resolves synchronously and the
     *  in-flight map is already empty by the time the next caller
     *  arrives — the dedup never gets exercised. */
    await new Promise((r) => setTimeout(r, 0));
    return {
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            token_prices: { [TOKEN.toLowerCase()]: priceFn(url, TOKEN) },
          },
        },
      }),
    };
  };
  return calls;
}

describe("in-flight dedup", () => {
  it("collapses N concurrent same-token fetches into one cascade run", async () => {
    const calls = _stubFetch(() => 1.23);
    const N = 5;
    const promises = Array.from({ length: N }, () => fetchTokenPriceUsd(TOKEN));
    const results = await Promise.all(promises);
    /*- All callers see the same price, but the cascade was only
     *  consulted once.  The cascade tries Moralis → GeckoTerminal →
     *  DexScreener; without a Moralis key (test env), it should hit
     *  GeckoTerminal which uses one fetch.  Even if multiple sources
     *  run, the count must be << N. */
    assert.deepStrictEqual(results, Array(N).fill(1.23));
    assert.ok(
      calls.length <= 3,
      `cascade should run at most once (≤3 source calls), got ${calls.length}`,
    );
  });

  it("clears the in-flight slot after the promise settles", async () => {
    _stubFetch(() => 0.5);
    await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(
      _inflightSize(),
      0,
      "in-flight map must be empty once the fetch settles",
    );
  });

  it("does not collapse fetches for different tokens", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      await new Promise((r) => setTimeout(r, 0));
      const isA = url.toLowerCase().includes(TOKEN.toLowerCase());
      const tokenAddr = isA ? TOKEN.toLowerCase() : TOKEN_B.toLowerCase();
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: { token_prices: { [tokenAddr]: isA ? 1 : 2 } },
          },
        }),
      };
    };
    const [a, b] = await Promise.all([
      fetchTokenPriceUsd(TOKEN),
      fetchTokenPriceUsd(TOKEN_B),
    ]);
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 2);
    /*- Each token gets its own cascade, so the URL list must contain at
     *  least one call referencing each token's address. */
    const sawA = urls.some((u) =>
      u.toLowerCase().includes(TOKEN.toLowerCase()),
    );
    const sawB = urls.some((u) =>
      u.toLowerCase().includes(TOKEN_B.toLowerCase()),
    );
    assert.ok(sawA && sawB, "both token addresses must appear in cascade URLs");
  });

  it("dedupes concurrent calls inside withFreshPricesAllowed", async () => {
    /*- Move scope no longer bypasses dedup — the rebalance/compound
     *  pipeline used to call the same source 4-6× per token within
     *  seconds (gas gate, slippage estimate, pre- and post-move PnL
     *  snapshots).  Now the in-flight dedup collapses concurrent
     *  same-token fetches onto one cascade run regardless of scope.
     *  The short in-move freshness TTL (moveCacheTtlMs, default 4 s)
     *  guarantees the cache value can't be more than that stale.
     *
     *  Baseline: a single non-move call resolves with one cascade run,
     *  which (in the test env, no Moralis key) makes exactly one HTTP
     *  call (GeckoTerminal).  Two concurrent in-move calls must
     *  produce the SAME baseline count — they share the same promise. */
    const calls = _stubFetch(() => 1);
    await fetchTokenPriceUsd(TOKEN);
    const baseline = calls.length;
    _cache.clear();
    _resetInflightForTests();
    await withFreshPricesAllowed(async () => {
      await Promise.all([fetchTokenPriceUsd(TOKEN), fetchTokenPriceUsd(TOKEN)]);
    });
    const inMoveCalls = calls.length - baseline;
    assert.equal(
      inMoveCalls,
      baseline,
      `inMove must dedupe; expected ${baseline} calls, got ${inMoveCalls}`,
    );
  });

  it("serves cached value to in-move calls within the move TTL window", async () => {
    /*- First call in a move populates the cache; a subsequent call in
     *  the same move within moveCacheTtlMs must hit the cache, not
     *  the cascade.  The default 4 s window covers a typical rebalance
     *  burst (gas gate → slippage → PnL snapshots) which fires within
     *  ~5 s of move start. */
    const calls = _stubFetch(() => 1);
    _cache.clear();
    _resetInflightForTests();
    await withFreshPricesAllowed(async () => {
      await fetchTokenPriceUsd(TOKEN);
      const afterFirst = calls.length;
      await fetchTokenPriceUsd(TOKEN);
      const afterSecond = calls.length;
      assert.equal(
        afterSecond,
        afterFirst,
        "second in-move call must hit cache (no new HTTP call)",
      );
    });
  });

  it("sequential calls after settlement run a fresh cascade (no stale dedup)", async () => {
    const calls = _stubFetch(() => 1);
    await fetchTokenPriceUsd(TOKEN);
    const firstCount = calls.length;
    /*- Bust the cache so the second call cannot short-circuit on a
     *  cache hit; it must reach the dedup/cascade path. */
    _cache.clear();
    await fetchTokenPriceUsd(TOKEN);
    assert.ok(
      calls.length > firstCount,
      "second call after settlement must hit the cascade again",
    );
  });
});
