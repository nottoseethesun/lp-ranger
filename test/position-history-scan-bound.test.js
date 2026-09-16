/**
 * @file test/position-history-scan-bound.test.js
 * @description Guards that closed-position on-chain helpers in
 *   `position-history-scan-helpers.js` bound their getLogs scans to the
 *   pool's creation block (or the 5-year floor) instead of replaying every
 *   chain block back to genesis.
 *
 *   Covers the gap left by bb05ae8: `_supplementMintFromChain` was bounded
 *   but the Collect/DecreaseLiquidity scan (used by `_supplementAmountsFromChain` to
 *   pull exit/fee amounts for closed positions) still scanned from block 0.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const Module = require("module");

const FIVE_YEAR_BLOCKS = 15_800_000;

/**
 * Build an ethers stub whose JsonRpcProvider records every getLogs call.
 * `getBlockNumber` returns `latestBlock`; `getPool` returns the supplied
 * pool address (or ZeroAddress when null).  When `logsToReturn` is provided,
 * `getLogs` returns those logs instead of an empty array.
 */
function _buildEthersStub({
  latestBlock,
  poolAddress,
  getLogsCalls,
  logsToReturn,
}) {
  return {
    JsonRpcProvider: class {
      async getBlockNumber() {
        return latestBlock;
      }
      async getLogs(opts) {
        getLogsCalls.push(opts);
        return logsToReturn || [];
      }
      async getBlock() {
        return null;
      }
      destroy() {}
    },
    Contract: class {
      async getPool() {
        return poolAddress || "0x0000000000000000000000000000000000000000";
      }
      async positions() {
        return {
          token0: "0x" + "1".repeat(40),
          token1: "0x" + "2".repeat(40),
          fee: 3000,
        };
      }
    },
    Interface: class {
      getEvent(name) {
        return { topicHash: "0x" + name.padEnd(64, "0").slice(0, 64) };
      }
      parseLog() {
        return { args: { amount0: 0n, amount1: 0n } };
      }
    },
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  };
}

describe("position-history scan bound", () => {
  let origRequire;
  let getLogsCalls;
  let stub;

  beforeEach(() => {
    getLogsCalls = [];
    origRequire = Module.prototype.require;
  });

  afterEach(() => {
    Module.prototype.require = origRequire;
    /* Reset the in-memory pool-creation-block cache so each test starts
       from a clean slate (otherwise the first test's lookup pollutes
       subsequent tests). */
    const pcb = require("../src/pool-creation-block");
    if (typeof pcb._resetForTests === "function") pcb._resetForTests();
  });

  it("scanCollectAndDrain honors the fromBlock argument", async () => {
    stub = _buildEthersStub({
      latestBlock: 16_000_000,
      poolAddress: null,
      getLogsCalls,
    });
    Module.prototype.require = function (id) {
      if (id === "ethers") return stub;
      return origRequire.apply(this, arguments);
    };
    const {
      scanCollectAndDrain,
    } = require("../src/position-history-scan-helpers");
    const provider = new stub.JsonRpcProvider();
    await scanCollectAndDrain("12345", provider, 5_000_000);
    /*- Collect + DecreaseLiquidity, both bounded.  The scan is chunked,
     *  so this is many calls rather than two; what matters — and what
     *  this test has always been about — is that NOTHING is queried
     *  below the bound we passed in.  Asserting the floor states that
     *  directly, where a call count only ever implied it. */
    assert.ok(getLogsCalls.length > 0, "expected at least one query");
    const lowest = Math.min(...getLogsCalls.map((c) => c.fromBlock));
    assert.strictEqual(
      lowest,
      5_000_000,
      "no window may start below the fromBlock passed in",
    );
    /*- Both event types still queried, once each per window. */
    const topics = new Set(getLogsCalls.map((c) => c.topics[0]));
    assert.strictEqual(topics.size, 2, "Collect and DecreaseLiquidity");
  });

  it("scanCollectAndDrain defaults fromBlock to 0 (back-compat)", async () => {
    stub = _buildEthersStub({
      latestBlock: 16_000_000,
      poolAddress: null,
      getLogsCalls,
    });
    Module.prototype.require = function (id) {
      if (id === "ethers") return stub;
      return origRequire.apply(this, arguments);
    };
    const {
      scanCollectAndDrain,
    } = require("../src/position-history-scan-helpers");
    const provider = new stub.JsonRpcProvider();
    await scanCollectAndDrain("12345", provider);
    const lowest = Math.min(...getLogsCalls.map((c) => c.fromBlock));
    assert.strictEqual(lowest, 0);
  });

  it("resolveScanFromBlock returns max(latest - 5y, 0) when pool unknown", async () => {
    const latestBlock = 16_000_000;
    stub = _buildEthersStub({
      latestBlock,
      poolAddress: null /* getPool returns ZeroAddress -> unknown */,
      getLogsCalls,
    });
    Module.prototype.require = function (id) {
      if (id === "ethers") return stub;
      return origRequire.apply(this, arguments);
    };
    const {
      resolveScanFromBlock,
    } = require("../src/position-history-scan-helpers");
    const provider = new stub.JsonRpcProvider();
    const from = await resolveScanFromBlock(provider, stub, "12345");
    assert.strictEqual(from, latestBlock - FIVE_YEAR_BLOCKS);
    assert.ok(from > 0, "must be strictly greater than 0");
  });

  it("scanCollectAndDrain returns blockNumber alongside amounts", async () => {
    /*- Regression guard for the Moralis historical-price gap: the on-chain
        scan helpers must hand the block number back to callers so
        _supplementAmountsFromChain can populate result.closeBlockNumber and
        unlock the Moralis branch in _fetchHistoricalPair. */
    stub = _buildEthersStub({
      latestBlock: 16_000_000,
      poolAddress: null,
      getLogsCalls,
      logsToReturn: [
        {
          blockNumber: 14_500_000,
          /*- The token id is a real topic word: the read attributes each
           *  log to its NFT by `topics[1]`, as a node's logs always
           *  carry it. */
          topics: ["0xtopic", "0x" + (12345).toString(16).padStart(64, "0")],
          data: "0x",
        },
      ],
    });
    Module.prototype.require = function (id) {
      if (id === "ethers") return stub;
      return origRequire.apply(this, arguments);
    };
    const {
      scanCollectAndDrain,
    } = require("../src/position-history-scan-helpers");
    const provider = new stub.JsonRpcProvider();
    const out = await scanCollectAndDrain("12345", provider, 5_000_000);
    assert.ok(out, "must return a result when logs are present");
    const collected = out.collectEvents[out.collectEvents.length - 1];
    assert.strictEqual(collected.blockNumber, 14_500_000);
    assert.strictEqual(typeof collected.amount0, "bigint");
    assert.strictEqual(typeof collected.amount1, "bigint");
  });

  it("resolveScanFromBlock floors at 0 when chain is younger than 5y", async () => {
    const latestBlock = 1_000_000; /* < 15.8M */
    stub = _buildEthersStub({
      latestBlock,
      poolAddress: null,
      getLogsCalls,
    });
    Module.prototype.require = function (id) {
      if (id === "ethers") return stub;
      return origRequire.apply(this, arguments);
    };
    const {
      resolveScanFromBlock,
    } = require("../src/position-history-scan-helpers");
    const provider = new stub.JsonRpcProvider();
    const from = await resolveScanFromBlock(provider, stub, "12345");
    assert.strictEqual(from, 0, "fiveYearFloor clamps to 0");
  });
});
