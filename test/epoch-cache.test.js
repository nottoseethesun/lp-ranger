/**
 * @file test/epoch-cache.test.js
 * @description Tests for epoch-cache.js — disk-backed P&L epoch storage.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TMP = path.join(process.cwd(), "tmp");

describe("epoch-cache", () => {
  let getCachedEpochs, setCachedEpochs;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    // Remove stale cache so tests start clean (check.sh restores after)
    try {
      fs.unlinkSync(path.join(TMP, "pnl-epochs-cache.json"));
    } catch {
      /* */
    }
    ({ getCachedEpochs, setCachedEpochs } = require("../src/epoch-cache"));
  });

  it("returns null for unknown key", () => {
    assert.strictEqual(
      getCachedEpochs({
        contract: "x",
        wallet: "y",
        token0: "a",
        token1: "b",
        fee: 1,
      }),
      null,
    );
  });

  it("round-trips set then get", () => {
    const key = {
      contract: "0xAA",
      wallet: "0xBB",
      token0: "0xCC",
      token1: "0xDD",
      fee: 500,
    };
    const data = { closedEpochs: [{ entryValue: 100 }], liveEpoch: null };
    setCachedEpochs(key, data);
    const got = getCachedEpochs(key);
    assert.ok(got);
    assert.strictEqual(got.closedEpochs.length, 1);
    assert.strictEqual(got.closedEpochs[0].entryValue, 100);
  });

  it("prepends existing epochs when incoming has fewer", () => {
    const key = {
      contract: "0xAA",
      wallet: "0xBB",
      token0: "0xCC",
      token1: "0xDD",
      fee: 500,
    };
    // First: set with 3 closed epochs
    setCachedEpochs(key, {
      closedEpochs: [{ id: 1 }, { id: 2 }, { id: 3 }],
      liveEpoch: null,
    });
    // Second: set with only 1 closed epoch (e.g. partial reconstruction)
    setCachedEpochs(key, {
      closedEpochs: [{ id: 3 }],
      liveEpoch: { entryValue: 200 },
    });
    const got = getCachedEpochs(key);
    // Should prepend the 2 missing epochs from the existing cache
    assert.strictEqual(got.closedEpochs.length, 3);
    assert.strictEqual(got.closedEpochs[0].id, 1);
    assert.strictEqual(got.closedEpochs[1].id, 2);
    assert.strictEqual(got.closedEpochs[2].id, 3);
  });
});
