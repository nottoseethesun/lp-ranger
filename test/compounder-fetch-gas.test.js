/**
 * @file test/compounder-fetch-gas.test.js
 * @description Unit tests for `_fetchCompoundGas` in `src/compounder.js`.
 *
 * Split out of test/compounder.test.js to keep that file under the
 * project-wide 500-line limit.
 *
 * Regression history: historical compoundHistory entries used to land in
 * `.bot-config.json` with `timestamp: null, txHash: null`, which made
 * any planned UI rendering pointless.  `_fetchCompoundGas` is now the
 * single source for both fields — the historical writer in
 * `bot-recorder.js#_classifyAllCompounds` plumbs them through unchanged.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("_fetchCompoundGas", () => {
  it("populates timestamp + txHash for each compound event", async () => {
    const { _fetchCompoundGas } = require("../src/compounder");
    const blockTs = 1777000000;
    const prov = {
      getTransactionReceipt: async () => ({
        gasUsed: 100000n,
        gasPrice: 1000n,
      }),
      getBlock: async (n) => ({ timestamp: blockTs + n }),
    };
    const events = [
      { amount0: 1n, amount1: 2n, blockNumber: 10, txHash: "0xa" },
      { amount0: 3n, amount1: 4n, blockNumber: 11, txHash: "0xb" },
    ];
    const { compounds } = await _fetchCompoundGas(prov, events);
    assert.equal(compounds.length, 2);
    assert.equal(compounds[0].txHash, "0xa");
    assert.equal(
      compounds[0].timestamp,
      new Date((blockTs + 10) * 1000).toISOString(),
    );
    assert.equal(compounds[1].txHash, "0xb");
    assert.equal(
      compounds[1].timestamp,
      new Date((blockTs + 11) * 1000).toISOString(),
    );
  });

  it("caches block timestamps when multiple events share a block", async () => {
    const { _fetchCompoundGas } = require("../src/compounder");
    const fetchedBlocks = [];
    const prov = {
      getTransactionReceipt: async () => ({
        gasUsed: 0n,
        effectiveGasPrice: 0n,
      }),
      getBlock: async (n) => {
        fetchedBlocks.push(n);
        return { timestamp: 1234567890 };
      },
    };
    const events = [
      { amount0: 1n, amount1: 1n, blockNumber: 42, txHash: "0xa" },
      { amount0: 2n, amount1: 2n, blockNumber: 42, txHash: "0xb" },
      { amount0: 3n, amount1: 3n, blockNumber: 42, txHash: "0xc" },
    ];
    await _fetchCompoundGas(prov, events);
    assert.equal(fetchedBlocks.length, 1, "block 42 fetched only once");
  });

  it("falls back to null timestamp on getBlock failure", async () => {
    const { _fetchCompoundGas } = require("../src/compounder");
    const prov = {
      getTransactionReceipt: async () => ({
        gasUsed: 0n,
        effectiveGasPrice: 0n,
      }),
      getBlock: async () => {
        throw new Error("rpc unavailable");
      },
    };
    const events = [
      { amount0: 1n, amount1: 1n, blockNumber: 7, txHash: "0xd" },
    ];
    const { compounds } = await _fetchCompoundGas(prov, events);
    assert.equal(compounds[0].timestamp, null);
    assert.equal(compounds[0].txHash, "0xd", "txHash still preserved");
  });
});
