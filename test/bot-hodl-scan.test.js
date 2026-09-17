/**
 * @file test/bot-hodl-scan.test.js
 * @description Regression tests for the lifetime-HODL scan helpers:
 *  1. `computeAndCacheHodl` attaches `hodl.poolAddress` BEFORE calling
 *     `setCachedLifetimeHodl`, so persisted cache entries always have it
 *     (without this, subsequent bot restarts would load a poolAddress-less
 *     cached hodl and fall back to current prices when resolving lifetime
 *     deposit USD — see bot-hodl-scan.js:_ensureHodlPoolAddress docstring).
 *  2. `_ensureHodlPoolAddress` backfills a missing pool address from the
 *     factory and writes the updated hodl back to the epoch cache, so
 *     existing pre-fix cache entries self-heal on next startup.
 *  3. `_ensureHodlPoolAddress` returns the cached value without touching
 *     the chain when one is already present.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// ── Module-level require mocks for epoch-cache + rebalancer ─────────────

const _origRequire = Module.prototype.require;
let _cachedHodlWrites = [];
let _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
let _historicalImpl = async () => ({ price0: 0, price1: 0 });

/**
 * Local ethers stub matching the `mockEthersLib()` pattern used by
 * bot-loop.test.js / bot.test.js / hodl-baseline.test.js. The project has no
 * shared helper for this and no npm package provides a purpose-built ethers v6
 * mock (ganache is referenced in CLAUDE.md but not installed).
 *
 * Why needed: `bot-hodl-scan.computeAndCacheHodl` calls
 * `new ethers.JsonRpcProvider(config.RPC_URL)`, and ethers v6's real
 * constructor kicks off a background health-check poller that keeps the
 * process alive — causing `node:test` to hang at suite end even after the
 * test assertions have all passed.
 */
function mockEthersLib() {
  function JsonRpcProvider() {}
  JsonRpcProvider.prototype.destroy = function () {};
  return {
    JsonRpcProvider,
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  };
}
const _ETHERS_STUB = mockEthersLib();

function _installMocks() {
  Module.prototype.require = function (id) {
    if (id === "./epoch-cache") {
      return {
        getCachedFreshDeposits: () => null,
        setCachedLifetimeHodl: (key, hodl) => {
          // Deep-clone so later mutations to `hodl` don't leak into the
          // assertion — we want to verify the state AT CACHE TIME.
          _cachedHodlWrites.push({
            key,
            hodl: JSON.parse(JSON.stringify(hodl)),
          });
        },
        setCachedFreshDeposits: () => {},
      };
    }
    if (id === "./rebalancer") {
      return {
        getPoolState: async () => _poolStateImpl(),
      };
    }
    if (id === "ethers") return _ETHERS_STUB;
    /*- The historical price source, for the Re-scan Prices re-value.
     *  `hodl-baseline` reaches for the same module, and the stub is
     *  equally right there. */
    if (id === "./price-fetcher") {
      return {
        fetchHistoricalPriceGecko: (...args) => _historicalImpl(...args),
      };
    }
    /*- bot-hodl-scan now sources its provider via
     *  sendTx.getManagedReadProvider().  Return a stub for sendTx so
     *  the test doesn't need to drive a full send-transaction init. */
    if (id === "./send-transaction") {
      return {
        getManagedReadProvider: () => new _ETHERS_STUB.JsonRpcProvider(),
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-hodl-scan")];
}

function _restoreMocks() {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-hodl-scan")];
}

// ── computeAndCacheHodl ordering ────────────────────────────────────────

describe("computeAndCacheHodl — poolAddress ordering", () => {
  let computeAndCacheHodl;

  beforeEach(() => {
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ computeAndCacheHodl } = require("../src/bot-hodl-scan"));
  });

  afterEach(_restoreMocks);

  it("attaches hodl.poolAddress BEFORE writing to the epoch cache", async () => {
    const computeFn = async () => ({
      amount0: 100,
      amount1: 200,
      raw0: "100",
      raw1: "200",
      lastBlock: 50,
      deposits: [{ raw0: "100", raw1: "200", block: 10 }],
    });
    await computeAndCacheHodl(
      computeFn,
      [], // allNftEvents
      [], // rebalanceEvents
      {
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tokenId: 1,
      },
      { decimals0: 18, decimals1: 18 },
      "0xW",
      "epoch-key-1",
    );
    assert.strictEqual(_cachedHodlWrites.length, 1);
    assert.strictEqual(
      _cachedHodlWrites[0].hodl.poolAddress,
      "0xPOOL",
      "poolAddress must be in the hodl object at cache-write time",
    );
  });

  it("omits poolAddress when the pool state resolve fails", async () => {
    _poolStateImpl = () => {
      throw new Error("RPC timeout");
    };
    const computeFn = async () => ({
      amount0: 1,
      amount1: 2,
      raw0: "1",
      raw1: "2",
      lastBlock: 0,
      deposits: [],
    });
    await computeAndCacheHodl(
      computeFn,
      [],
      [],
      { token0: "0xA", token1: "0xB", fee: 500, tokenId: 2 },
      { decimals0: 18, decimals1: 18 },
      "0xW",
      "epoch-key-2",
    );
    assert.strictEqual(_cachedHodlWrites.length, 1);
    assert.strictEqual(_cachedHodlWrites[0].hodl.poolAddress, undefined);
  });
});

// ── _ensureHodlPoolAddress backfill ─────────────────────────────────────

describe("_ensureHodlPoolAddress", () => {
  let _ensureHodlPoolAddress;

  beforeEach(() => {
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ _ensureHodlPoolAddress } = require("../src/bot-hodl-scan"));
  });

  afterEach(_restoreMocks);

  it("returns the already-cached poolAddress without touching the chain", async () => {
    // Throwing would cause the test to fail if getPoolState is invoked.
    _poolStateImpl = () => {
      throw new Error("getPoolState should not be called");
    };
    const botState = {
      lifetimeHodlAmounts: { poolAddress: "0xCACHED", deposits: [] },
    };
    const result = await _ensureHodlPoolAddress(
      botState,
      { token0: "0xA", token1: "0xB", fee: 3000 },
      "epoch-key",
      {},
      {},
    );
    assert.strictEqual(result, "0xCACHED");
    assert.strictEqual(_cachedHodlWrites.length, 0);
  });

  it("backfills a missing poolAddress and persists it to the epoch cache", async () => {
    const botState = {
      lifetimeHodlAmounts: {
        deposits: [{ raw0: "1", raw1: "2", block: 1 }],
      },
    };
    const result = await _ensureHodlPoolAddress(
      botState,
      { token0: "0xA", token1: "0xB", fee: 3000 },
      "epoch-key-backfill",
      {},
      {},
    );
    assert.strictEqual(result, "0xPOOL");
    assert.strictEqual(botState.lifetimeHodlAmounts.poolAddress, "0xPOOL");
    assert.strictEqual(_cachedHodlWrites.length, 1);
    assert.strictEqual(_cachedHodlWrites[0].key, "epoch-key-backfill");
    assert.strictEqual(_cachedHodlWrites[0].hodl.poolAddress, "0xPOOL");
  });

  it("returns '' when getPoolState fails, without writing to the cache", async () => {
    _poolStateImpl = () => {
      throw new Error("RPC unreachable");
    };
    const botState = {
      lifetimeHodlAmounts: { deposits: [] },
    };
    const result = await _ensureHodlPoolAddress(
      botState,
      { token0: "0xA", token1: "0xB", fee: 3000 },
      "epoch-key-fail",
      {},
      {},
    );
    assert.strictEqual(result, "");
    assert.strictEqual(_cachedHodlWrites.length, 0);
    assert.strictEqual(botState.lifetimeHodlAmounts.poolAddress, undefined);
  });

  it("skips the cache write when no epochKey is provided", async () => {
    const botState = { lifetimeHodlAmounts: { deposits: [] } };
    const result = await _ensureHodlPoolAddress(
      botState,
      { token0: "0xA", token1: "0xB", fee: 3000 },
      null,
      {},
      {},
    );
    assert.strictEqual(result, "0xPOOL");
    assert.strictEqual(botState.lifetimeHodlAmounts.poolAddress, "0xPOOL");
    assert.strictEqual(_cachedHodlWrites.length, 0);
  });
});

// ── revalueHodlBaseline (Re-scan Prices) ────────────────────────────────

describe("revalueHodlBaseline", () => {
  let revalueHodlBaseline;
  let patches;

  const POSITION = { token0: "0xA", token1: "0xB", fee: 3000, tokenId: 7 };
  /** A saved baseline: 10 of token0 and 20 of token1, valued at $100. */
  const saved = () => ({
    entryValue: 100,
    hodlAmount0: 10,
    hodlAmount1: 20,
    token0UsdPrice: 6,
    token1UsdPrice: 2,
    mintDate: "2026-03-15",
    mintTimestamp: 1_773_000_000,
    mintGasWei: "42",
  });
  const stateWith = (baseline) => ({
    hodlBaseline: baseline,
    lifetimeHodlAmounts: { poolAddress: "0xPOOL", deposits: [] },
  });

  beforeEach(() => {
    patches = [];
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _historicalImpl = async () => ({ price0: 2, price1: 3 });
    _installMocks();
    ({ revalueHodlBaseline } = require("../src/bot-hodl-scan"));
  });

  afterEach(_restoreMocks);

  const run = (botState, mintBlock) =>
    revalueHodlBaseline(
      botState,
      (p) => patches.push(p),
      POSITION,
      mintBlock,
      "epoch-key",
    );

  it("re-prices the mint amounts, which it keeps as the chain recorded them", async () => {
    const botState = stateWith(saved());
    await run(botState, 123);
    const base = botState.hodlBaseline;
    assert.strictEqual(base.entryValue, 10 * 2 + 20 * 3);
    assert.strictEqual(base.hodlAmount0, 10, "amounts are not re-derived");
    assert.strictEqual(base.hodlAmount1, 20);
    assert.strictEqual(base.mintDate, "2026-03-15");
    assert.strictEqual(base.mintGasWei, "42");
    assert.strictEqual(patches.length, 1, "the dashboard is told once");
  });

  it("reads past the cached price, at the block of this NFT's mint", async () => {
    let seen = null;
    _historicalImpl = async (_pool, ts, _network, opts) => {
      seen = { ts, opts };
      return { price0: 1, price1: 1 };
    };
    await run(stateWith(saved()), 123);
    assert.strictEqual(seen.ts, 1_773_000_000, "priced at the mint");
    assert.strictEqual(seen.opts.blockNumber, 123);
    assert.strictEqual(
      seen.opts.refresh,
      true,
      "a cached bad price is what this action exists to replace",
    );
  });

  it("keeps the saved figure when no price comes back", async () => {
    _historicalImpl = async () => ({ price0: 0, price1: 0 });
    const botState = stateWith(saved());
    await run(botState, 123);
    assert.strictEqual(botState.hodlBaseline.entryValue, 100, "left alone");
    assert.strictEqual(patches.length, 0);
  });

  it("does nothing when there is no saved baseline", async () => {
    const botState = stateWith(null);
    await run(botState, 123);
    assert.strictEqual(botState.hodlBaseline, null);
    assert.strictEqual(patches.length, 0);
  });

  it("leaves a baseline that carries no mint amounts", async () => {
    /*- Amounts come from the mint event, so a baseline without them is
     *  one no scan wrote. Multiplying by a price would publish NaN into
     *  the Lifetime panel and into the value the IL Guard measures
     *  against. */
    const baseline = { ...saved(), hodlAmount0: undefined };
    const botState = stateWith(baseline);
    await run(botState, 123);
    assert.strictEqual(botState.hodlBaseline.entryValue, 100, "untouched");
    assert.strictEqual(patches.length, 0);
  });
});
