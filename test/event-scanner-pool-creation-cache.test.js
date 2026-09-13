"use strict";

/**
 * @file test/event-scanner-pool-creation-cache.test.js
 * @description The wallet-scoped LP scan must resolve the pool-creation
 *   block through the disk cache.
 *
 * `event-scanner.js` `resolveFromBlock` routes that lookup through
 * `getPoolCreationBlockCached`, which memoises in-process and persists
 * to disk, rather than calling the raw `findPoolCreationBlock`
 * primitive.  Calling the primitive repeats the search on every
 * wallet-scoped LP scan, once per position opened and once per restart.
 *
 * This test asserts the integration: across two consecutive
 * `scanRebalanceHistory` calls for the same pool, the deployment-block
 * search must run only once.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");

/*- Scope the disk cache to this test run. */
process.env.POOL_CREATION_BLOCK_CACHE_PATH = path.join(
  os.tmpdir(),
  "pool-creation-blocks-cache-eslc-test-" + process.pid + ".json",
);

const { scanRebalanceHistory } = require("../src/event-scanner");
const poolCreationBlock = require("../src/pool-creation-block");

const WALLET = "0xABCDEF0000000000000000000000000000000001";
const POS_MGR = "0x1234560000000000000000000000000000000099";
const FACTORY = "0xe50DBdC88E87a2C92984d794bcF3D1d76f619C68";
const POOL = "0x9999990000000000000000000000000000000000";
const TOKEN0 = "0x1111110000000000000000000000000000000001";
const TOKEN1 = "0x2222220000000000000000000000000000000002";
const FEE = 10000;

const CURRENT_BLOCK = 1_000_000;
const POOL_CREATION_BLOCK = 950_000;

/**
 * Position-manager stub: the wallet scan's Transfer queries return
 * nothing, so the scan completes without producing rebalances.
 */
function mkEthers() {
  return {
    Contract: class {
      constructor(address) {
        this._addr = String(address).toLowerCase();
        this.filters = { Transfer: () => ({ _kind: "Transfer" }) };
      }
      async queryFilter() {
        return [];
      }
    },
  };
}

/**
 * Provider reporting POOL as deployed at POOL_CREATION_BLOCK, counting
 * every `getCode` — the call the deployment-block search is made of.
 */
function mkProvider(counter) {
  return {
    getBlockNumber: async () => CURRENT_BLOCK,
    getBlock: async (n) => ({ timestamp: 1_700_000_000 + n }),
    async getCode(_addr, blk) {
      counter.codeCalls += 1;
      return blk >= POOL_CREATION_BLOCK ? "0x60806040" : "0x";
    },
  };
}

describe("event-scanner: pool-creation-block cache integration", () => {
  beforeEach(() => poolCreationBlock._resetForTests());
  afterEach(() => poolCreationBlock._resetForTests());

  it("uses the cached pool-creation resolver across repeat scans", async () => {
    const counter = { codeCalls: 0 };
    const ethers = mkEthers();
    const provider = mkProvider(counter);

    /*- First scan: cold cache → the deployment-block search runs. */
    await scanRebalanceHistory(provider, ethers, {
      positionManagerAddress: POS_MGR,
      walletAddress: WALLET,
      factoryAddress: FACTORY,
      poolAddress: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      poolFee: FEE,
      chunkDelayMs: 0,
    });
    assert.ok(
      counter.codeCalls > 0,
      "first scan should resolve the deployment block",
    );
    const firstScanCalls = counter.codeCalls;

    /*- Second scan, same pool: warm cache → no further deployment-block
        lookup, regardless of how many wallet chunks run. */
    await scanRebalanceHistory(provider, ethers, {
      positionManagerAddress: POS_MGR,
      walletAddress: WALLET,
      factoryAddress: FACTORY,
      poolAddress: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      poolFee: FEE,
      chunkDelayMs: 0,
    });
    assert.equal(
      counter.codeCalls,
      firstScanCalls,
      "second scan must hit the disk-cached resolver — no new getCode calls",
    );
  });
});
