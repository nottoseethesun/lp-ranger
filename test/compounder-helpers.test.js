/**
 * @file test/compounder-helpers.test.js
 * @description Tests for _filterRebalances and _parseLogs in compounder.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _filterRebalances, _parseLogs } = require("../src/compounder");

// ── _filterRebalances ───────────────────────────────────────────────

describe("_filterRebalances", () => {
  it("returns all candidates when no drain events", () => {
    const candidates = [{ blockNumber: 100 }, { blockNumber: 200 }];
    const result = _filterRebalances(candidates, []);
    assert.strictEqual(result.length, 2);
  });

  it("filters out candidates within drain window", () => {
    const candidates = [
      { blockNumber: 1000 },
      { blockNumber: 1100 }, // within 50000 blocks of drain at 1050
      { blockNumber: 60000 }, // outside window
    ];
    const dlEvents = [{ liquidity: 100n, blockNumber: 1050 }];
    const result = _filterRebalances(candidates, dlEvents);
    // 1000 is BEFORE drain, so not filtered
    // 1100 is within window (1100 >= 1050 && 1100 - 1050 = 50 <= 50000)
    // 60000 is within window (60000 >= 1050 && 60000 - 1050 = 58950 > 50000)
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].blockNumber, 1000);
    assert.strictEqual(result[1].blockNumber, 60000);
  });

  it("filters candidates that fall after drain and within window", () => {
    const candidates = [{ blockNumber: 5000 }, { blockNumber: 5500 }];
    const dlEvents = [{ liquidity: 1n, blockNumber: 5000 }];
    const result = _filterRebalances(candidates, dlEvents);
    // 5000 >= 5000 && 5000-5000=0 <= 50000 → filtered
    // 5500 >= 5000 && 5500-5000=500 <= 50000 → filtered
    assert.strictEqual(result.length, 0);
  });

  it("ignores drain events with zero liquidity", () => {
    const candidates = [{ blockNumber: 100 }];
    const dlEvents = [{ liquidity: 0n, blockNumber: 90 }];
    const result = _filterRebalances(candidates, dlEvents);
    assert.strictEqual(result.length, 1);
  });

  it("ignores drain events with null liquidity", () => {
    const candidates = [{ blockNumber: 100 }];
    const dlEvents = [{ blockNumber: 90 }];
    const result = _filterRebalances(candidates, dlEvents);
    assert.strictEqual(result.length, 1);
  });

  it("handles empty candidates", () => {
    const result = _filterRebalances([], [{ liquidity: 1n, blockNumber: 10 }]);
    assert.strictEqual(result.length, 0);
  });

  it("handles multiple drain events", () => {
    const candidates = [
      { blockNumber: 100 },
      { blockNumber: 200000 },
      { blockNumber: 200050 },
    ];
    const dlEvents = [
      { liquidity: 1n, blockNumber: 50 },
      { liquidity: 1n, blockNumber: 200000 },
    ];
    // 100 >= 50 && 100-50=50 <= 50000 → filtered
    // 200000 >= 200000 && 0 <= 50000 → filtered
    // 200050 >= 200000 && 50 <= 50000 → filtered
    // 200050 >= 50 && 200050-50=200000 > 50000 → NOT filtered by first drain
    // But filtered by second drain: 200050 >= 200000 && 50 <= 50000
    const result = _filterRebalances(candidates, dlEvents);
    assert.strictEqual(result.length, 0);
  });
});

// ── _parseLogs ──────────────────────────────────────────────────────

describe("_parseLogs", () => {
  it("returns empty array for empty logs", () => {
    const iface = { parseLog: () => ({}) };
    const result = _parseLogs(iface, []);
    assert.deepStrictEqual(result, []);
  });

  it("parses valid logs", () => {
    const iface = {
      parseLog: () => ({
        args: {
          amount0: 100n,
          amount1: 200n,
          liquidity: 500n,
        },
      }),
    };
    const logs = [
      {
        topics: ["0xabc"],
        data: "0x123",
        blockNumber: 42,
        transactionHash: "0xhash",
      },
    ];
    const result = _parseLogs(iface, logs);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].amount0, 100n);
    assert.strictEqual(result[0].amount1, 200n);
    assert.strictEqual(result[0].liquidity, 500n);
    assert.strictEqual(result[0].blockNumber, 42);
    assert.strictEqual(result[0].txHash, "0xhash");
  });

  it("skips unparseable logs", () => {
    const iface = {
      parseLog: () => {
        throw new Error("bad log");
      },
    };
    const logs = [{ topics: [], data: "0x", blockNumber: 1 }];
    const result = _parseLogs(iface, logs);
    assert.strictEqual(result.length, 0);
  });

  it("parses mix of valid and invalid logs", () => {
    let callCount = 0;
    const iface = {
      parseLog: () => {
        callCount++;
        if (callCount === 2) throw new Error("bad");
        return {
          args: { amount0: 1n, amount1: 2n, liquidity: 3n },
        };
      },
    };
    const logs = [
      { topics: [], data: "0x", blockNumber: 10, transactionHash: "0xa" },
      { topics: [], data: "0x", blockNumber: 20, transactionHash: "0xb" },
      { topics: [], data: "0x", blockNumber: 30, transactionHash: "0xc" },
    ];
    const result = _parseLogs(iface, logs);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].blockNumber, 10);
    assert.strictEqual(result[1].blockNumber, 30);
  });
});
