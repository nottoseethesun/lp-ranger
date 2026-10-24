/**
 * @file test/bot-hodl-scan.test.js
 * @description Regression tests for the lifetime-HODL scan helpers:
 *  1. `computeAndCacheHodl` attaches `hodl.poolAddress` BEFORE calling
 *     `setCachedLifetimeHodl`, so persisted cache entries always have it
 *     (without this, subsequent bot restarts would load a poolAddress-less
 *     cached hodl and fall back to current prices when resolving lifetime
 *     deposit USD — see bot-hodl-scan.js:_ensureHodlPoolAddress docstring).
 *  2. `_ensureHodlPoolAddress` resolves a missing pool address from the
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
let _freshWrites = [];
// The saved fresh-deposit record, read when the scan starts and when it writes.
let _freshReads = () => null;
let _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
let _historicalImpl = async () => ({ price0: 0, price1: 0 });
let _blockTsImpl = async () => 0;

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
        getCachedFreshDeposits: () => _freshReads(),
        setCachedLifetimeHodl: (key, hodl) => {
          // Deep-clone so later mutations to `hodl` don't leak into the
          // assertion — we want to verify the state AT CACHE TIME.
          _cachedHodlWrites.push({
            key,
            hodl: JSON.parse(JSON.stringify(hodl)),
          });
        },
        setCachedFreshDeposits: (_key, data) =>
          _freshWrites.push(JSON.parse(JSON.stringify(data))),
      };
    }
    if (id === "./rebalancer-pools") {
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
    // When a deposit's block was mined, for its historical price.
    if (id === "./block-time-cache") {
      return {
        getBlockTimestamp: (...args) => _blockTsImpl(...args),
        flushBlockTimeCache: () => {},
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/lib/bot-hodl-scan")];
}

function _restoreMocks() {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/lib/bot-hodl-scan")];
}

// ── computeAndCacheHodl ordering ────────────────────────────────────────

describe("computeAndCacheHodl — poolAddress ordering", () => {
  let computeAndCacheHodl;

  beforeEach(() => {
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ computeAndCacheHodl } = require("../src/lib/bot-hodl-scan"));
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

// ── A deposit count saved while the scan ran ──────────────────────────────

describe("computeAndCacheHodl — the compounds this install made", () => {
  /*-
   *  The tally reads no receipt for a compound LP Ranger recorded, which
   *  paid from the wallet (src/lib/lifetime-hodl.js), so it is handed the
   *  compound list as saved
   *  when it runs: after this pass's rebuild of it, which keeps every
   *  compound the bot recorded.
   */
  let computeAndCacheHodl;

  beforeEach(() => {
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ computeAndCacheHodl } = require("../src/lib/bot-hodl-scan"));
  });

  afterEach(_restoreMocks);

  it("hands the tally the compound list as saved when it runs", async () => {
    const saved = [{ txHash: "0xc", trigger: "auto" }];
    let handed;
    const computeFn = async (_events, o) => {
      handed = o.compoundHistory;
      return {
        amount0: 1,
        amount1: 2,
        raw0: "0",
        raw1: "0",
        lastBlock: 0,
        deposits: [],
      };
    };
    await computeAndCacheHodl(
      computeFn,
      [],
      [],
      { token0: "0xA", token1: "0xB", fee: 500, tokenId: 2 },
      { decimals0: 18, decimals1: 18, savedCompoundHistory: () => saved },
      "0xW",
      null,
    );
    assert.strictEqual(handed, saved);
  });
});

describe("computeAndCacheHodl — a deposit count saved while the scan ran", () => {
  /*-
   *  The scan read the saved results when it started. A Compound Now
   *  during the scan counted a deposit and saved it. The scan's own write
   *  must keep that deposit, rather than drop it with the stale copy it
   *  started from.
   */
  let computeAndCacheHodl;
  const COUNTED = {
    raw0: "40",
    raw1: "0",
    block: 900,
    kind: "fresh",
    txHash: "0xcounted",
  };
  const scanned = () => ({
    amount0: 1,
    amount1: 2,
    raw0: "0",
    raw1: "0",
    lastBlock: 50,
    deposits: [{ raw0: "100", raw1: "200", block: 10 }],
  });

  beforeEach(() => {
    _cachedHodlWrites = [];
    _freshWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ computeAndCacheHodl } = require("../src/lib/bot-hodl-scan"));
  });

  afterEach(() => {
    _freshReads = () => null;
    _restoreMocks();
  });

  /** Run the scan with `computed` as its result, reads answering in turn. */
  function scan(reads) {
    let n = 0;
    _freshReads = () => reads[Math.min(n++, reads.length - 1)];
    return computeAndCacheHodl(
      async () => scanned(),
      [],
      [],
      { token0: "0xA", token1: "0xB", fee: 3000, tokenId: 1 },
      { decimals0: 2, decimals1: 2 },
      "0xW",
      "epoch-key-3",
    );
  }

  it("keeps the count, its coins and how far it read", async () => {
    const atStart = { raw0: "0", raw1: "0", lastBlock: 50, deposits: [] };
    const atWrite = { ...atStart, deposits: [COUNTED], countedThrough: 950 };
    const hodl = await scan([atStart, atWrite]);
    assert.deepEqual(
      hodl.deposits.map((d) => d.txHash ?? d.block),
      [10, "0xcounted"],
    );
    assert.equal(hodl.amount0, 1.4);
    assert.equal(hodl.raw0, "40");
    assert.equal(hodl.countedThrough, 950);
    assert.equal(_cachedHodlWrites[0].hodl.countedThrough, 950);
    assert.equal(_freshWrites.length, 1, "the saved list is the scan's");
    assert.equal(_freshWrites[0].countedThrough, 950);
  });

  it("writes the scan's own results when nothing landed meanwhile", async () => {
    const saved = { raw0: "0", raw1: "0", lastBlock: 50, deposits: [] };
    const hodl = await scan([saved, saved]);
    assert.equal(hodl.deposits.length, 1);
    assert.equal(hodl.countedThrough, undefined);
    assert.equal(_freshWrites.length, 0, "nothing new to save there");
  });
});

// ── _ensureHodlPoolAddress pool-address resolution ─────────────────────────────────────

describe("_ensureHodlPoolAddress", () => {
  let _ensureHodlPoolAddress;

  beforeEach(() => {
    _cachedHodlWrites = [];
    _poolStateImpl = () => ({ poolAddress: "0xPOOL" });
    _installMocks();
    ({ _ensureHodlPoolAddress } = require("../src/lib/bot-hodl-scan"));
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
    );
    assert.strictEqual(result, "0xCACHED");
    assert.strictEqual(_cachedHodlWrites.length, 0);
  });

  it("resolves a missing poolAddress and persists it to the epoch cache", async () => {
    const botState = {
      lifetimeHodlAmounts: {
        deposits: [{ raw0: "1", raw1: "2", block: 1 }],
      },
    };
    const result = await _ensureHodlPoolAddress(
      botState,
      { token0: "0xA", token1: "0xB", fee: 3000 },
      "epoch-key-resolve",
      {},
    );
    assert.strictEqual(result, "0xPOOL");
    assert.strictEqual(botState.lifetimeHodlAmounts.poolAddress, "0xPOOL");
    assert.strictEqual(_cachedHodlWrites.length, 1);
    assert.strictEqual(_cachedHodlWrites[0].key, "epoch-key-resolve");
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
    ({ revalueHodlBaseline } = require("../src/lib/bot-hodl-scan"));
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
    _historicalImpl = async (_pool, ts, opts) => {
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

describe("computeDepositUsd — a deposit block with no readable time", () => {
  /*-
   *  A deposit is priced at its own block's candle. Without the block's
   *  time there is no such candle: asking for today's instead would cache
   *  today's price under the block's key, which never expires, and value
   *  the deposit at it unflagged.
   */
  let computeDepositUsd;
  let asked;

  const botState = () => ({
    lifetimeHodlAmounts: {
      poolAddress: "0xPOOL",
      deposits: [{ raw0: "1000000000000000000", raw1: "0", block: 555 }],
    },
  });
  // No token addresses, so a missing price is not looked up at today's rate.
  const POSITION = { fee: 3000, tokenId: 7 };
  const OPTS = { decimals0: 18, decimals1: 18 };

  beforeEach(() => {
    asked = [];
    _historicalImpl = async (pool, ts, opts) => {
      asked.push({ pool, ts, block: opts.blockNumber });
      return { price0: 2, price1: 3 };
    };
    _installMocks();
    ({ computeDepositUsd } = require("../src/lib/bot-hodl-scan"));
  });

  afterEach(() => {
    _blockTsImpl = async () => 0;
    _restoreMocks();
  });

  it("asks for no historical price when the block's time cannot be read", async () => {
    _blockTsImpl = async () => 0;
    const state = botState();
    await computeDepositUsd(state, () => {}, POSITION, OPTS, "epoch-key");
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(state.totalLifetimeDepositUsd, undefined);
  });

  it("prices the deposit at its own block's time when it can be read", async () => {
    _blockTsImpl = async () => 1_700_000_000;
    const state = botState();
    await computeDepositUsd(state, () => {}, POSITION, OPTS, "epoch-key");
    assert.deepStrictEqual(asked, [
      { pool: "0xPOOL", ts: 1_700_000_000, block: 555 },
    ]);
    assert.strictEqual(state.totalLifetimeDepositUsd, 2);
  });
});

describe("computeDepositUsd — a newer list saved while one is priced", () => {
  /*-
   *  A Compound Now's deposit count can save a newer deposit list while a
   *  Lifetime scan prices the one it holds, and the other way round. The
   *  total written is the standing list's: an older list's would leave
   *  out what the newer one added, until the next pricing.
   */
  let computeDepositUsd;
  const POSITION = { fee: 3000, tokenId: 7 };
  const OPTS = { decimals0: 18, decimals1: 18 };
  const ONE = "1000000000000000000";
  const first = () => ({ raw0: ONE, raw1: "0", block: 555 });

  beforeEach(() => {
    _blockTsImpl = async () => 1_700_000_000;
    _installMocks();
    ({ computeDepositUsd } = require("../src/lib/bot-hodl-scan"));
  });

  afterEach(() => {
    _blockTsImpl = async () => 0;
    _historicalImpl = async () => ({ price0: 0, price1: 0 });
    _restoreMocks();
  });

  it("writes the total of the list standing when its pricing ends", async () => {
    const entry = first();
    const state = {
      lifetimeHodlAmounts: { poolAddress: "0xPOOL", deposits: [entry] },
    };
    const blocks = [];
    _historicalImpl = async (_pool, _ts, opts) => {
      blocks.push(opts.blockNumber);
      if (blocks.length === 1)
        state.lifetimeHodlAmounts = {
          ...state.lifetimeHodlAmounts,
          deposits: [
            entry,
            { raw0: ONE, raw1: "0", block: 600, txHash: "0xd" },
          ],
        };
      return { price0: 2, price1: 3 };
    };
    await computeDepositUsd(state, () => {}, POSITION, OPTS, "epoch-key");
    assert.strictEqual(state.totalLifetimeDepositUsd, 4, "both coins, at $2");
    assert.deepStrictEqual(blocks, [555, 600], "no price asked for twice");
  });

  it("writes nothing once Reload cleared the results meanwhile", async () => {
    const state = {
      lifetimeHodlAmounts: { poolAddress: "0xPOOL", deposits: [first()] },
      totalLifetimeDepositUsd: 0,
    };
    _historicalImpl = async () => {
      state.lifetimeHodlAmounts = null;
      return { price0: 2, price1: 3 };
    };
    await computeDepositUsd(state, () => {}, POSITION, OPTS, "epoch-key");
    assert.strictEqual(state.totalLifetimeDepositUsd, 0);
  });
});
