/**
 * @file test/position-details-compound.test.js
 * @description Tests for _scanCompounds in position-details.js.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("_scanCompounds", () => {
  let _scanCompounds;
  let _mockResult = { totalCompoundedUsd: 0 };
  const _origRequire = Module.prototype.require;

  before(() => {
    // Intercept require("./compounder") to return a mock
    Module.prototype.require = function (id) {
      if (id === "./compounder") {
        return {
          detectCompoundsOnChain: async () => _mockResult,
        };
      }
      return _origRequire.apply(this, arguments);
    };
    // Clear cached module so it picks up our mock
    delete require.cache[require.resolve("../src/position-details")];
    ({ _scanCompounds } = require("../src/position-details"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
  });

  it("returns 0 when no compounds detected", async () => {
    _mockResult = { totalCompoundedUsd: 0 };
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
    );
    assert.strictEqual(result, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it("returns total and updates in-memory config when compounds found", async () => {
    _mockResult = { totalCompoundedUsd: 5.5 };
    const cfg = { global: {}, positions: {} };
    const result = await _scanCompounds(
      { tokenId: "200", token0: "0xA", token1: "0xB", fee: 3000 },
      [{ oldTokenId: "199", newTokenId: "200" }],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
    );
    assert.ok(result > 0, "should return compound total");
    // Verifies in-memory config was updated (saveConfig also writes to disk)
    // Mock returns 5.5 per NFT, 2 NFTs scanned (199, 200) = 11
    assert.strictEqual(cfg.positions["test-key"].totalCompoundedUsd, 11);
  });

  it("collects NFT IDs from events and position", async () => {
    const scannedIds = [];
    Module.prototype.require = function (id) {
      if (id === "./compounder") {
        return {
          detectCompoundsOnChain: async (tid) => {
            scannedIds.push(tid);
            return { totalCompoundedUsd: 0 };
          },
        };
      }
      return _origRequire.apply(this, arguments);
    };
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
    );
    // Should scan all unique IDs: 298, 299, 300
    assert.ok(scannedIds.includes("298"));
    assert.ok(scannedIds.includes("299"));
    assert.ok(scannedIds.includes("300"));
  });

  it("returns 0 on error", async () => {
    Module.prototype.require = function (id) {
      if (id === "./compounder") {
        return {
          detectCompoundsOnChain: async () => {
            throw new Error("RPC fail");
          },
        };
      }
      return _origRequire.apply(this, arguments);
    };
    const cfg = { global: {}, positions: {} };
    const result = await _scanCompounds(
      { tokenId: "400", token0: "0xA", token1: "0xB", fee: 3000 },
      [{ oldTokenId: "399", newTokenId: "400" }],
      { walletAddress: "0xW" },
      { decimals0: 18, decimals1: 18 },
      { price0: 1, price1: 1 },
      cfg,
      "test-key",
    );
    assert.strictEqual(result, 0);
  });
});
