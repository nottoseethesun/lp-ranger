"use strict";

/**
 * @file test/pool-creation-finder.test.js
 * @description Unit tests for the primitive Factory PoolCreated scanner.
 *
 * Most callers should use `getPoolCreationBlockCached` from
 * `pool-creation-block.js` (covered by `test/pool-creation-block.test.js`);
 * this file covers the underlying linear-scan primitive directly so the
 * not-found / RPC-error / missing-args branches are explicit.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { findPoolCreationBlock } = require("../src/pool-creation-finder");

const FACTORY = "0xFACT000000000000000000000000000000000001";
const POOL = "0xP00L000000000000000000000000000000000002";

function mkProvider(block = 1_000_000) {
  return {
    getBlockNumber: async () => block,
    getBlock: async (n) => ({ timestamp: 1_700_000_000 + n }),
  };
}

const poolOpts = (extra = {}) => ({
  factoryAddress: FACTORY,
  poolAddress: POOL,
  fromBlock: 0,
  toBlock: 10_000,
  ...extra,
});

function mkFactoryEthers(events) {
  return {
    Contract: class {
      constructor() {
        this.filters = { PoolCreated: () => ({ topics: [] }) };
        this.queryFilter = async () => events;
      }
    },
  };
}

describe("findPoolCreationBlock", () => {
  it("returns block when pool found", async () => {
    const r = await findPoolCreationBlock(
      mkProvider(10_000),
      mkFactoryEthers([
        { args: [null, null, null, null, POOL], blockNumber: 5000 },
      ]),
      poolOpts(),
    );
    assert.strictEqual(r, 5000);
  });

  it("returns null when not found", async () => {
    const r = await findPoolCreationBlock(
      mkProvider(10_000),
      mkFactoryEthers([]),
      poolOpts(),
    );
    assert.strictEqual(r, null);
  });

  it("returns null when addresses missing", async () => {
    const e = { Contract: class {} };
    assert.strictEqual(
      await findPoolCreationBlock(
        mkProvider(),
        e,
        poolOpts({ factoryAddress: null }),
      ),
      null,
    );
    assert.strictEqual(
      await findPoolCreationBlock(
        mkProvider(),
        e,
        poolOpts({ poolAddress: null }),
      ),
      null,
    );
  });

  it("handles RPC errors gracefully", async () => {
    const ethers = {
      Contract: class {
        constructor() {
          this.filters = { PoolCreated: () => ({ topics: [] }) };
          this.queryFilter = async () => {
            throw new Error("RPC");
          };
        }
      },
    };
    assert.strictEqual(
      await findPoolCreationBlock(mkProvider(), ethers, poolOpts()),
      null,
    );
  });
});
