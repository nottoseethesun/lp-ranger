"use strict";

/**
 * @file test/event-scanner-pool-creation-cache.test.js
 * @description The wallet-scoped LP scan must resolve the pool-creation
 *   block through the disk cache.
 *
 * `event-scanner.js` `resolveFromBlock` routes that lookup through
 * `getPoolCreationBlockCached`, which memoises in-process and persists
 * to disk, rather than calling the raw `findPoolCreationBlock`
 * primitive.  Calling the primitive re-scans the V3 Factory's
 * PoolCreated logs from scratch on every wallet-scoped LP scan — a
 * 5-year lookback is ~150 50k-chunk Factory queries before the wallet
 * scan starts, repeated each time a different position is opened or the
 * process restarts.
 *
 * This test asserts the integration: two consecutive `scanRebalanceHistory`
 * calls for the same pool must trigger the Factory `PoolCreated`
 * `queryFilter` only once.
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
 * Build an ethers stub whose Contract differentiates two contract types by
 * the address it was constructed with: the Factory returns one PoolCreated
 * event matching POOL; the position-manager returns no Transfer events
 * (so the scan completes without producing rebalances).  Counts every
 * Factory `queryFilter` call.
 */
function mkEthers(counter) {
  return {
    Contract: class {
      constructor(address) {
        this._addr = String(address).toLowerCase();
        this.filters = {
          PoolCreated: () => ({ _kind: "PoolCreated" }),
          Transfer: () => ({ _kind: "Transfer" }),
        };
      }
      async queryFilter(filter, fromBlock /*, toBlock */) {
        if (filter._kind === "PoolCreated") {
          counter.factoryQueries += 1;
          /*- Factory scans 0..currentBlock in 50k chunks; emit the
              creation event only inside the chunk that covers it. */
          if (
            POOL_CREATION_BLOCK >= fromBlock &&
            POOL_CREATION_BLOCK < fromBlock + 50_000
          ) {
            return [
              {
                args: { 4: POOL, pool: POOL },
                blockNumber: POOL_CREATION_BLOCK,
              },
            ];
          }
          return [];
        }
        /*- Transfer queries from the wallet scan: no events. */
        return [];
      }
    },
  };
}

function mkProvider() {
  return {
    getBlockNumber: async () => CURRENT_BLOCK,
    getBlock: async (n) => ({ timestamp: 1_700_000_000 + n }),
  };
}

describe("event-scanner: pool-creation-block cache integration", () => {
  beforeEach(() => poolCreationBlock._resetForTests());
  afterEach(() => poolCreationBlock._resetForTests());

  it("uses the cached pool-creation resolver across repeat scans", async () => {
    const counter = { factoryQueries: 0 };
    const ethers = mkEthers(counter);
    const provider = mkProvider();

    /*- First scan: cold cache → Factory must be hit (chunked scan up to
        block 950k = 19 chunks of 50k under default chunkSize). */
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
      counter.factoryQueries > 0,
      "first scan should query Factory at least once",
    );
    const firstScanQueries = counter.factoryQueries;

    /*- Second scan, same pool: warm cache → Factory must NOT be queried
        again, regardless of how many wallet chunks run. */
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
      counter.factoryQueries,
      firstScanQueries,
      "second scan must hit the disk-cached resolver — no new Factory queries",
    );
  });
});
