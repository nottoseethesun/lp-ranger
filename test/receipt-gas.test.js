"use strict";

/**
 * @file test/receipt-gas.test.js
 * @description
 * `receiptGasWei` — the single expression of what a confirmed transaction
 * cost, which thirteen call sites across nine modules now share.
 *
 * These cases came from `rebalancer-aggregator._gasCost` and moved here with
 * the function. They pin the two field names (`gasPrice` and the v5-shaped
 * `effectiveGasPrice`), which one wins when both are present, and that a
 * receipt missing either yields `0n` rather than throwing — a cost that cannot
 * be determined is reported as nothing rather than failing a move that has
 * already succeeded on chain.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { receiptGasWei } = require("../src/receipt-gas");

describe("receiptGasWei", () => {
  it("computes gas cost from receipt", () => {
    const r = { gasUsed: 21000n, gasPrice: 50000000000n };
    assert.strictEqual(receiptGasWei(r), 21000n * 50000000000n);
  });

  it("uses effectiveGasPrice when gasPrice is missing", () => {
    const r = { gasUsed: 100n, effectiveGasPrice: 200n };
    assert.strictEqual(receiptGasWei(r), 100n * 200n);
  });

  it("returns 0n when gasUsed is missing", () => {
    assert.strictEqual(receiptGasWei({}), 0n);
  });

  it("returns 0n for empty receipt fields", () => {
    const r = { gasUsed: 0n, gasPrice: 0n };
    assert.strictEqual(receiptGasWei(r), 0n);
  });

  it("prefers gasPrice over effectiveGasPrice", () => {
    const r = { gasUsed: 10n, gasPrice: 5n, effectiveGasPrice: 3n };
    assert.strictEqual(receiptGasWei(r), 50n);
  });
});
