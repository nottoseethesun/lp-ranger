/**
 * @file test/pool-creation-block.test.js
 * @description Tests for the pool-creation-block disk-cached resolver.
 *
 * Regression history: HODL baseline, compound classifier, closed-position
 * history, and unmanaged-position details all used `fromBlock: 0` for NFT
 * event scans, replaying every block back to chain genesis.  This module
 * resolves the pool's `PoolCreated` block once per pool, caches it to disk,
 * and feeds it to those scans as a tighter lower bound.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

/*- Scope the cache file to this test run's PID so concurrent test runs and
    a live production app never clobber each other's caches. */
process.env.POOL_CREATION_BLOCK_CACHE_PATH = path.join(
  os.tmpdir(),
  "pool-creation-blocks-cache-test-" + process.pid + ".json",
);

const mod = require("../src/pool-creation-block");

const FACTORY = "0xe50DBdC88E87a2C92984d794bcF3D1d76f619C68";
const POOL = "0x1234567890aBcdef1234567890ABcdef12345678";

describe("pool-creation-block", () => {
  beforeEach(() => mod._resetForTests());
  afterEach(() => mod._resetForTests());

  it("returns 0 when required args are missing", async () => {
    assert.equal(await mod.getPoolCreationBlockCached({}), 0);
    assert.equal(
      await mod.getPoolCreationBlockCached({
        provider: {},
        ethersLib: {},
        factoryAddress: FACTORY,
      }),
      0,
    );
    assert.equal(
      await mod.getPoolCreationBlockCached({
        provider: {},
        ethersLib: {},
        poolAddress: POOL,
      }),
      0,
    );
  });

  it("returns 0 and does not throw when the underlying scan fails", async () => {
    const provider = {
      getBlockNumber: async () => {
        throw new Error("rpc down");
      },
    };
    const result = await mod.getPoolCreationBlockCached({
      provider,
      ethersLib: {},
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(result, 0);
  });

  it("caches a successful lookup in memory and on disk", async () => {
    let calls = 0;
    const provider = {
      getBlockNumber: async () => 200,
    };
    /*- Stub ethersLib.Contract so findPoolCreationBlock returns block 100. */
    const ethersLib = {
      Contract: class {
        constructor() {}
        filters = {
          PoolCreated: () => ({}),
        };
        async queryFilter() {
          calls += 1;
          return [
            {
              args: { 4: POOL, pool: POOL },
              blockNumber: 100,
            },
          ];
        }
      },
    };
    const first = await mod.getPoolCreationBlockCached({
      provider,
      ethersLib,
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(first, 100);
    assert.equal(calls, 1);
    /*- Second call hits the in-memory cache. */
    const second = await mod.getPoolCreationBlockCached({
      provider,
      ethersLib,
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(second, 100);
    assert.equal(calls, 1);
    /*- Disk cache file is written. */
    const raw = JSON.parse(fs.readFileSync(mod._CACHE_PATH, "utf8"));
    const key = FACTORY.toLowerCase() + "|" + POOL.toLowerCase();
    assert.equal(raw[key], 100);
  });

  it("dedupes concurrent in-flight lookups for the same pool", async () => {
    let calls = 0;
    const provider = {
      getBlockNumber: async () => 300,
    };
    const ethersLib = {
      Contract: class {
        constructor() {}
        filters = { PoolCreated: () => ({}) };
        async queryFilter() {
          calls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return [{ args: { 4: POOL, pool: POOL }, blockNumber: 42 }];
        }
      },
    };
    const [a, b, c] = await Promise.all([
      mod.getPoolCreationBlockCached({
        provider,
        ethersLib,
        factoryAddress: FACTORY,
        poolAddress: POOL,
      }),
      mod.getPoolCreationBlockCached({
        provider,
        ethersLib,
        factoryAddress: FACTORY,
        poolAddress: POOL,
      }),
      mod.getPoolCreationBlockCached({
        provider,
        ethersLib,
        factoryAddress: FACTORY,
        poolAddress: POOL,
      }),
    ]);
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(c, 42);
    assert.equal(calls, 1);
  });

  it("re-throws AbortError so cancellation propagates to the caller", async () => {
    /*- Regression: an earlier version of the cached wrapper swallowed
        AbortError in its generic catch block and returned 0, hiding the
        cancel from event-scanner's downstream abort checks. */
    const provider = {
      getBlockNumber: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    };
    await assert.rejects(
      () =>
        mod.getPoolCreationBlockCached({
          provider,
          ethersLib: {},
          factoryAddress: FACTORY,
          poolAddress: POOL,
        }),
      (err) => err.name === "AbortError",
    );
  });

  it("returns 0 (and caches it) when the pool is not found", async () => {
    const provider = {
      getBlockNumber: async () => 500,
    };
    const ethersLib = {
      Contract: class {
        constructor() {}
        filters = { PoolCreated: () => ({}) };
        async queryFilter() {
          return []; /*- never matches POOL */
        }
      },
    };
    const result = await mod.getPoolCreationBlockCached({
      provider,
      ethersLib,
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(result, 0);
  });

  describe("resolvePoolAddressForToken", () => {
    it("returns null when args are missing", async () => {
      assert.equal(await mod.resolvePoolAddressForToken({}), null);
    });

    it("returns null when factory.getPool returns ZeroAddress", async () => {
      const ZeroAddress = "0x0000000000000000000000000000000000000000";
      const ethersLib = {
        ZeroAddress,
        Contract: class {
          async positions() {
            return {
              token0: "0xaaa",
              token1: "0xbbb",
              fee: 3000,
            };
          }
          async getPool() {
            return ZeroAddress;
          }
        },
      };
      const result = await mod.resolvePoolAddressForToken({
        provider: {},
        ethersLib,
        positionManagerAddress: "0xpm",
        factoryAddress: FACTORY,
        tokenId: "1",
      });
      assert.equal(result, null);
    });

    it("returns the pool address when the factory resolves it", async () => {
      const ethersLib = {
        ZeroAddress: "0x0000000000000000000000000000000000000000",
        Contract: class {
          async positions() {
            return { token0: "0xaaa", token1: "0xbbb", fee: 3000 };
          }
          async getPool() {
            return POOL;
          }
        },
      };
      const result = await mod.resolvePoolAddressForToken({
        provider: {},
        ethersLib,
        positionManagerAddress: "0xpm",
        factoryAddress: FACTORY,
        tokenId: "1",
      });
      assert.equal(result, POOL);
    });

    it("returns null when the positions() lookup throws", async () => {
      const ethersLib = {
        ZeroAddress: "0x0",
        Contract: class {
          async positions() {
            throw new Error("nope");
          }
        },
      };
      const result = await mod.resolvePoolAddressForToken({
        provider: {},
        ethersLib,
        positionManagerAddress: "0xpm",
        factoryAddress: FACTORY,
        tokenId: "1",
      });
      assert.equal(result, null);
    });
  });
});
