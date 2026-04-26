/**
 * @file test/position-details-compound.test.js
 * @description Tests for _scanCompounds in position-details.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { _scanCompounds } = require("../src/position-details");

describe("_scanCompounds", () => {
  const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-shared-"));

  it("returns 0 when no compounds detected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
    const cfg = { global: {}, positions: {} };
    const result = await _scanCompounds(
      { tokenId: "100", token0: "0xA", token1: "0xB", fee: 3000 },
      [{ oldTokenId: "99", newTokenId: "100" }],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
      dir,
      async () => ({ totalCompoundedUsd: 0 }),
    );
    assert.strictEqual(result, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it("returns total and updates in-memory config when compounds found", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test2-"));
    const cfg = { global: {}, positions: {} };
    const result = await _scanCompounds(
      { tokenId: "200", token0: "0xA", token1: "0xB", fee: 3000 },
      [{ oldTokenId: "199", newTokenId: "200" }],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
      dir,
      async () => ({ totalCompoundedUsd: 5.5 }),
    );
    assert.ok(result > 0, "should return compound total");
    // Mock returns 5.5 per NFT, 2 NFTs scanned (199, 200) = 11
    assert.strictEqual(cfg.positions["test-key"].totalCompoundedUsd, 11);
    fs.rmSync(dir, { recursive: true });
  });

  it("collects NFT IDs from events and position", async () => {
    const scannedIds = [];
    const cfg = { global: {}, positions: {} };
    await _scanCompounds(
      { tokenId: "300", token0: "0xA", token1: "0xB", fee: 3000 },
      [
        { oldTokenId: "298", newTokenId: "299" },
        { oldTokenId: "299", newTokenId: "300" },
      ],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
      _tmpDir,
      async (tid) => {
        scannedIds.push(tid);
        return { totalCompoundedUsd: 0 };
      },
    );
    // Should scan all unique IDs: 298, 299, 300
    assert.ok(scannedIds.includes("298"));
    assert.ok(scannedIds.includes("299"));
    assert.ok(scannedIds.includes("300"));
  });

  it("returns 0 on error", async () => {
    const cfg = { global: {}, positions: {} };
    const result = await _scanCompounds(
      { tokenId: "400", token0: "0xA", token1: "0xB", fee: 3000 },
      [{ oldTokenId: "399", newTokenId: "400" }],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
      _tmpDir,
      async () => {
        throw new Error("RPC fail");
      },
    );
    assert.strictEqual(result, 0);
  });
});
