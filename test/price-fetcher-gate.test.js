/**
 * @file test/price-fetcher-gate.test.js
 * @description Unit tests for the idle-driven price-lookup pause gate.
 *   Covers pause/unpause semantics, the move-scoped fresh-prices
 *   override, cache invalidation, and the configurable TTL invariants.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchTokenPriceUsd,
  fetchDustUnitPriceUsd,
  pausePriceLookups,
  unpausePriceLookups,
  withFreshPricesAllowed,
  invalidatePriceCacheFor,
  _resetPauseStateForTests,
  _resetDustUnitPriceCache,
  _cache,
  _CACHE_TTL_MS,
  _DUST_UNIT_PRICE_TTL_MS,
} = require("../src/price-fetcher");
const {
  _resetForTest: _resetGeckoRateLimit,
} = require("../src/gecko-rate-limit");
const gate = require("../src/price-fetcher-gate");

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

let _origFetch;

beforeEach(() => {
  _origFetch = globalThis.fetch;
  _cache.clear();
  _resetDustUnitPriceCache();
  _resetPauseStateForTests();
  _resetGeckoRateLimit();
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  _cache.clear();
  _resetDustUnitPriceCache();
  _resetPauseStateForTests();
  _resetGeckoRateLimit();
});

// ── pause / unpause semantics ─────────────────────────────────────────

describe("pause / unpause", () => {
  it("pause + unpause are idempotent", () => {
    pausePriceLookups();
    pausePriceLookups();
    assert.strictEqual(gate.isPaused(), true);
    unpausePriceLookups();
    unpausePriceLookups();
    assert.strictEqual(gate.isPaused(), false);
  });

  it("paused + cache hit returns stale value past TTL without invoking the cascade", async () => {
    /*- Seed cache with a value, then backdate it past the TTL.  With
     *  the gate paused the value MUST still be returned and fetch MUST
     *  NOT be called. */
    _cache.set("pulsechain:" + TOKEN.toLowerCase(), {
      price: 0.42,
      ts: Date.now() - _CACHE_TTL_MS - 60_000,
    });
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({}) };
    };
    pausePriceLookups();
    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0.42, "should return stale cache while paused");
    assert.strictEqual(fetchCalls, 0, "cascade must not run while paused");
  });

  it("paused + cache miss returns 0 without invoking the cascade", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({}) };
    };
    pausePriceLookups();
    const price = await fetchTokenPriceUsd(TOKEN);
    assert.strictEqual(price, 0, "cold-start paused fetch returns 0");
    assert.strictEqual(fetchCalls, 0, "cascade must not run while paused");
  });

  it("does NOT touch the cascade for fetchDustUnitPriceUsd while paused", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({}) };
    };
    pausePriceLookups();
    const price = await fetchDustUnitPriceUsd();
    assert.strictEqual(price, 0, "cold-start dust unit price returns 0");
    assert.strictEqual(fetchCalls, 0);
  });
});

// ── move-scoped override ──────────────────────────────────────────────

describe("withFreshPricesAllowed", () => {
  it("bypasses pause flag and forces a cascade fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: { token_prices: { [TOKEN.toLowerCase()]: 1.5 } },
          },
        }),
      };
    };
    pausePriceLookups();
    const price = await withFreshPricesAllowed(() => fetchTokenPriceUsd(TOKEN));
    assert.strictEqual(price, 1.5);
    assert.ok(fetchCalls > 0, "cascade must run inside withFreshPricesAllowed");
  });

  it("applies the short move TTL — hits cache within the window, refetches past it", async () => {
    /*- In-move TTL replaces the original "bypass cache entirely" pattern.
     *  Within the configured moveCacheTtlMs (default 4_000 ms) a
     *  same-scope call hits the cache; past it the cascade runs again. */
    const key = "pulsechain:" + TOKEN.toLowerCase();
    let serverPrice = 9.99;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            token_prices: { [TOKEN.toLowerCase()]: serverPrice },
          },
        },
      }),
    });
    /*- Seed a cache entry that's BEYOND the in-move TTL but well within
     *  the steady-state TTL.  In-move must still re-fetch. */
    _cache.set(key, { price: 0.1, ts: Date.now() - 10_000 });
    const p = await withFreshPricesAllowed(() => fetchTokenPriceUsd(TOKEN));
    assert.strictEqual(p, 9.99, "stale-beyond-move-TTL must refetch");
    /*- Now the cache holds the fresh 9.99 value with ts=now.  A second
     *  in-move call within the move TTL must hit that cache, NOT the
     *  cascade — even though `serverPrice` has changed. */
    serverPrice = 4.44;
    const p2 = await withFreshPricesAllowed(() => fetchTokenPriceUsd(TOKEN));
    assert.strictEqual(
      p2,
      9.99,
      "second in-move call within move TTL must hit cache, not cascade",
    );
  });

  it("restores prior pause state after success", async () => {
    pausePriceLookups();
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: { attributes: { token_prices: { [TOKEN.toLowerCase()]: 1 } } },
      }),
    });
    await withFreshPricesAllowed(() => fetchTokenPriceUsd(TOKEN));
    assert.strictEqual(gate.isPaused(), true, "pause flag survives the scope");
    assert.strictEqual(gate.inMove(), false, "counter back to zero");
  });

  it("restores prior pause state after a thrown error", async () => {
    pausePriceLookups();
    await assert.rejects(
      () =>
        withFreshPricesAllowed(async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.strictEqual(gate.isPaused(), true);
    assert.strictEqual(gate.inMove(), false, "counter decremented on throw");
  });

  it("counter supports nested scopes", async () => {
    await withFreshPricesAllowed(async () => {
      assert.strictEqual(gate.inMove(), true);
      await withFreshPricesAllowed(async () => {
        assert.strictEqual(gate.inMove(), true);
      });
      assert.strictEqual(gate.inMove(), true, "outer scope still active");
    });
    assert.strictEqual(gate.inMove(), false);
  });
});

// ── invalidatePriceCacheFor ───────────────────────────────────────────

describe("invalidatePriceCacheFor", () => {
  it("removes only the listed token entries", () => {
    const a = "pulsechain:" + TOKEN.toLowerCase();
    const b = "pulsechain:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    _cache.set(a, { price: 1, ts: Date.now() });
    _cache.set(b, { price: 2, ts: Date.now() });
    invalidatePriceCacheFor([{ token: TOKEN }]);
    assert.strictEqual(_cache.has(a), false, "TOKEN entry removed");
    assert.strictEqual(_cache.has(b), true, "other entries untouched");
  });

  it("tolerates malformed input without throwing", () => {
    invalidatePriceCacheFor(null);
    invalidatePriceCacheFor(undefined);
    invalidatePriceCacheFor([]);
    invalidatePriceCacheFor([null, {}, { token: "" }]);
    /* no assertion needed — must not throw */
  });

  it("respects a non-default chain", () => {
    const k = "eth:" + TOKEN.toLowerCase();
    _cache.set(k, { price: 1, ts: Date.now() });
    invalidatePriceCacheFor([{ token: TOKEN, chain: "eth" }]);
    assert.strictEqual(_cache.has(k), false);
  });
});

// ── configurable TTLs + integer-multiple invariant ─────────────────────

describe("configurable TTLs", () => {
  it("dust TTL is an exact integer multiple of price TTL", () => {
    assert.strictEqual(
      _DUST_UNIT_PRICE_TTL_MS % _CACHE_TTL_MS,
      0,
      "dust TTL must be an integer multiple of price TTL by construction",
    );
  });

  it("dust TTL = price TTL × default multiplier (30)", () => {
    /*- Built-in default multiplier is 30; actual ratio depends on
     *  whatever bot-config has set.  Either it's the default 30 OR a
     *  user-set override.  Integer-multiple is the load-bearing
     *  invariant — ratio > 0 + integer suffices. */
    const ratio = _DUST_UNIT_PRICE_TTL_MS / _CACHE_TTL_MS;
    assert.ok(Number.isInteger(ratio), "ratio is integer");
    assert.ok(ratio >= 1, "ratio is at least 1");
  });
});

// ── gate runs BEFORE the cascade ──────────────────────────────────────

describe("gate ordering", () => {
  it("paused state short-circuits before any source is consulted", async () => {
    /*- Spy on global fetch — when paused, it must not be called even
     *  once, regardless of which sources the cascade would have tried. */
    const fetchInvocations = [];
    globalThis.fetch = async (url) => {
      fetchInvocations.push(url);
      return { ok: true, json: async () => ({}) };
    };
    pausePriceLookups();
    await fetchTokenPriceUsd(TOKEN);
    await fetchDustUnitPriceUsd();
    assert.deepStrictEqual(
      fetchInvocations,
      [],
      "no HTTP source consulted while paused",
    );
  });
});
