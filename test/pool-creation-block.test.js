/**
 * @file test/pool-creation-block.test.js
 * @description Tests for the pool-creation-block disk-cached resolver.
 *
 * Four callers need a lower bound for their NFT event scans — HODL
 * baseline, compound classifier, closed-position history and
 * unmanaged-position details — and without one each replays every block
 * back to chain genesis.  This module resolves the pool's deployment
 * block once per pool and caches it in memory and on disk, so the bound
 * costs one lookup per pool rather than one per scan.
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
    /*- Counted on `getBlockNumber`, which the resolver calls exactly once
     *  per cold lookup.  Counting `getCode` would count the binary
     *  search's own steps instead. */
    let lookups = 0;
    const provider = {
      getBlockNumber: async () => {
        lookups += 1;
        return 200;
      },
      getCode: async (_addr, blk) => (blk >= 100 ? "0x60806040" : "0x"),
    };
    const first = await mod.getPoolCreationBlockCached({
      provider,
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(first, 100);
    assert.equal(lookups, 1);
    /*- Second call hits the in-memory cache. */
    const second = await mod.getPoolCreationBlockCached({
      provider,
      factoryAddress: FACTORY,
      poolAddress: POOL,
    });
    assert.equal(second, 100);
    assert.equal(lookups, 1);
    /*- Disk cache file is written. */
    const raw = JSON.parse(fs.readFileSync(mod._CACHE_PATH, "utf8"));
    const key = FACTORY.toLowerCase() + "|" + POOL.toLowerCase();
    assert.equal(raw[key], 100);
  });

  it("dedupes concurrent in-flight lookups for the same pool", async () => {
    let lookups = 0;
    const provider = {
      getBlockNumber: async () => {
        lookups += 1;
        /*- Hold the first lookup open so the other two arrive while it is
         *  still in flight — otherwise they would hit the memo instead and
         *  the dedup path would go untested. */
        await new Promise((r) => setTimeout(r, 10));
        return 300;
      },
      getCode: async (_addr, blk) => (blk >= 42 ? "0x60806040" : "0x"),
    };
    const call = () =>
      mod.getPoolCreationBlockCached({
        provider,
        factoryAddress: FACTORY,
        poolAddress: POOL,
      });
    const [a, b, c] = await Promise.all([call(), call(), call()]);
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(c, 42);
    assert.equal(lookups, 1);
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
    /*- No code at the head: the pool does not exist on this chain, so the
     *  finder answers null and the resolver degrades to 0 — which callers
     *  discard in favour of their own floor. */
    const provider = {
      getBlockNumber: async () => 500,
      getCode: async () => "0x",
    };
    const result = await mod.getPoolCreationBlockCached({
      provider,
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
