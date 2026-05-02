/**
 * @file test/liquidity-pair-details.test.js
 * @description Tests for the per-scope "liquidity pair details" disk cache.
 *   Covers: scope-keyed lookup, idempotent fetch+persist, atomic write,
 *   reload from disk, env-var path isolation, missing-arg short-circuits,
 *   and graceful degradation when the historical price fetch throws.
 */

"use strict";

const path = require("path");
const fs = require("fs");

// CRITICAL: redirect cache path BEFORE requiring the module, so tests cannot
// clobber the production file regardless of how they are invoked.
process.env.LIQUIDITY_PAIR_DETAILS_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  `test-liquidity-pair-details-${process.pid}.json`,
);

// Stub out the historical-price fetcher BEFORE requiring the module under
// test, so the production fetcher (network + cache writes) never runs.
const Module = require("module");
const _origResolve = Module._resolve_filename || Module._resolveFilename;
let _stubPrice0 = 0;
let _stubPrice1 = 0;
let _stubThrows = false;
let _stubPriceCalls = 0;
const _origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "./price-fetcher" || request.endsWith("/price-fetcher")) {
    return {
      fetchHistoricalPriceGecko: async () => {
        _stubPriceCalls++;
        if (_stubThrows) throw new Error("stubbed price failure");
        return { price0: _stubPrice0, price1: _stubPrice1 };
      },
    };
  }
  return _origLoad.call(this, request, parent, ...rest);
};

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureInitialResidualData,
  loadInitialResidualData,
  _resetForTest,
  _CACHE_PATH,
} = require("../src/liquidity-pair-details");
const { liquidityPairScopeKey } = require("../src/cache-store");

/** Mock ethers module used to inject deterministic balance reads. */
function _makeEthersStub({ rawBal0, rawBal1, decimals0, decimals1 }) {
  let _idx = 0;
  const balances = [rawBal0, rawBal1];
  const decimals = [decimals0, decimals1];
  return {
    Contract: class {
      constructor() {
        this._i = _idx++;
      }
      async balanceOf(_owner, _opts) {
        return balances[this._i];
      }
      async decimals() {
        return decimals[this._i];
      }
    },
    formatUnits: (raw, dec) => {
      const s = String(raw);
      if (dec === 0) return s;
      const padded = s.padStart(dec + 1, "0");
      const intPart = padded.slice(0, -dec) || "0";
      const fracPart = padded.slice(-dec).replace(/0+$/, "");
      return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
    },
  };
}

function _baseArgs(overrides = {}) {
  return {
    chain: "pulsechain",
    factory: "0xCC05bf00000000000000000000000000000000aB",
    wallet: "0x4e448400000000000000000000000000000000Cd",
    token0: "0x95B30398aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token1: "0xA1077A29bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    fee: 2500,
    firstMintBlock: 12345,
    firstMintTimestamp: 1700000000,
    poolAddress: "0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9",
    provider: {},
    ethersLib: _makeEthersStub({
      rawBal0: 1000000000n,
      rawBal1: 2000000000000000000n,
      decimals0: 6,
      decimals1: 18,
    }),
    ...overrides,
  };
}

describe("liquidity-pair-details cache", () => {
  beforeEach(() => {
    _resetForTest();
    _stubPrice0 = 0;
    _stubPrice1 = 0;
    _stubThrows = false;
    _stubPriceCalls = 0;
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
  });

  after(() => {
    try {
      fs.unlinkSync(_CACHE_PATH);
    } catch {
      /* ignore */
    }
    Module._load = _origLoad;
  });

  it("uses an isolated env-var cache path so it cannot clobber production", () => {
    assert.match(_CACHE_PATH, /test-liquidity-pair-details-\d+\.json$/);
  });

  it("loadInitialResidualData returns null for an unknown scope", () => {
    assert.equal(loadInitialResidualData("missing-scope-key"), null);
  });

  it("ensureInitialResidualData populates the cache on first call", async () => {
    _stubPrice0 = 0.5;
    _stubPrice1 = 1500;
    const args = _baseArgs();
    const data = await ensureInitialResidualData(args);
    assert.ok(data, "should return data");
    assert.equal(data.token0Amount, 1000); // 1e9 / 1e6
    assert.equal(data.token0Price, 0.5);
    assert.equal(data.token1Amount, 2); // 2e18 / 1e18
    assert.equal(data.token1Price, 1500);
    assert.equal(
      data.date,
      new Date(args.firstMintTimestamp * 1000).toISOString(),
    );
    // Persisted under the canonical scope key.
    const scope = liquidityPairScopeKey({
      blockchain: args.chain,
      factory: args.factory,
      wallet: args.wallet,
      token0: args.token0,
      token1: args.token1,
      fee: args.fee,
    });
    const onDisk = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
    assert.deepEqual(onDisk[scope].initialResidualData, data);
  });

  it("is idempotent: a second call short-circuits and does not re-fetch", async () => {
    _stubPrice0 = 0.5;
    _stubPrice1 = 1500;
    await ensureInitialResidualData(_baseArgs());
    assert.equal(_stubPriceCalls, 1);
    // Second call should hit the cache; price fetch must not run again.
    await ensureInitialResidualData(_baseArgs());
    assert.equal(_stubPriceCalls, 1);
  });

  it("survives an in-memory reset by reloading from disk", async () => {
    _stubPrice0 = 0.5;
    _stubPrice1 = 1500;
    await ensureInitialResidualData(_baseArgs());
    _resetForTest();
    const scope = liquidityPairScopeKey({
      blockchain: "pulsechain",
      factory: _baseArgs().factory,
      wallet: _baseArgs().wallet,
      token0: _baseArgs().token0,
      token1: _baseArgs().token1,
      fee: 2500,
    });
    const reloaded = loadInitialResidualData(scope);
    assert.ok(reloaded);
    assert.equal(reloaded.token0Amount, 1000);
  });

  it("returns null when required args are missing", async () => {
    const r1 = await ensureInitialResidualData(
      _baseArgs({ firstMintBlock: 0 }),
    );
    assert.equal(r1, null);
    const r2 = await ensureInitialResidualData(
      _baseArgs({ poolAddress: null }),
    );
    assert.equal(r2, null);
    const r3 = await ensureInitialResidualData(_baseArgs({ provider: null }));
    assert.equal(r3, null);
  });

  it("reads balances at firstMintBlock end-of-block (post-mint state)", async () => {
    let observedBlockTag = null;
    const ethersLib = {
      Contract: class {
        async balanceOf(_owner, opts) {
          observedBlockTag = opts && opts.blockTag;
          return 1n;
        }
        async decimals() {
          return 18;
        }
      },
      formatUnits: (raw, _dec) => String(raw),
    };
    _stubPrice0 = 1;
    _stubPrice1 = 1;
    await ensureInitialResidualData(
      _baseArgs({ ethersLib, firstMintBlock: 9999 }),
    );
    assert.equal(observedBlockTag, 9999);
  });

  it("still persists with zero prices when historical price fetch throws", async () => {
    _stubThrows = true;
    const data = await ensureInitialResidualData(_baseArgs());
    assert.ok(data);
    assert.equal(data.token0Price, 0);
    assert.equal(data.token1Price, 0);
    assert.equal(data.token0Amount, 1000);
  });
});
