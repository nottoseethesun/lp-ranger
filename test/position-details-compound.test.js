/**
 * @file test/position-details-compound.test.js
 * @description Tests for _scanCompounds in position-details-compound.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { _scanCompounds } = require("../src/position-details-compound");

describe("_scanCompounds", () => {
  const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-shared-"));

  it("returns total=0, current=0 when no compounds detected", async () => {
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
      async () => ({ totalCompoundedUsd: 0, compounds: [] }),
    );
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
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
      async () => ({ totalCompoundedUsd: 5.5, compounds: [] }),
    );
    // Mock returns 5.5 per NFT, 2 NFTs scanned (199, 200) = total 11
    assert.strictEqual(result.total, 11);
    assert.strictEqual(cfg.positions["test-key"].totalCompoundedUsd, 11);
    fs.rmSync(dir, { recursive: true });
  });

  it("current = sum of standalone compounds' usdValue, not totalCompoundedUsd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-cur-"));
    const cfg = { global: {}, positions: {} };
    /*- Per-tokenId mock: current NFT (250) has totalCompoundedUsd=7.42
     *  (lifetime collected fees) but only 3 standalone compound events
     *  worth 2.21 each.  Verifies the loop sums the standalone events
     *  for `current` (matching bot-recorder-lifetime's compoundHistory
     *  model), not totalCompoundedUsd. */
    const perToken = {
      248: { totalCompoundedUsd: 1.0, compounds: [{ usdValue: 1.0 }] },
      249: { totalCompoundedUsd: 2.5, compounds: [{ usdValue: 2.5 }] },
      250: {
        totalCompoundedUsd: 7.42,
        compounds: [{ usdValue: 2.21 }, { usdValue: 2.21 }, { usdValue: 2.22 }],
      },
    };
    const result = await _scanCompounds(
      { tokenId: "250", token0: "0xA", token1: "0xB", fee: 3000 },
      [
        { oldTokenId: "248", newTokenId: "249" },
        { oldTokenId: "249", newTokenId: "250" },
      ],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
      dir,
      async (tid) => perToken[tid] || { totalCompoundedUsd: 0, compounds: [] },
    );
    assert.strictEqual(result.total, 1.0 + 2.5 + 7.42);
    assert.strictEqual(result.current, 2.21 + 2.21 + 2.22);
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
        return { totalCompoundedUsd: 0, compounds: [] };
      },
    );
    // Should scan all unique IDs: 298, 299, 300
    assert.ok(scannedIds.includes("298"));
    assert.ok(scannedIds.includes("299"));
    assert.ok(scannedIds.includes("300"));
  });

  it("returns total=0, current=0 on error", async () => {
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
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
  });
});
