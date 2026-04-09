"use strict";

const { describe, it, before } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TMP = path.join(process.cwd(), "tmp");

// Unique suffix prevents collisions when running concurrently with other suites.
const U = `-test-${process.pid}`;

describe("epoch-cache", () => {
  let getCachedEpochs, setCachedEpochs;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    ({ getCachedEpochs, setCachedEpochs } = require("../src/epoch-cache"));
  });

  it("returns null for unknown key", () => {
    assert.strictEqual(
      getCachedEpochs({
        contract: `x${U}`,
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
      contract: `0xAA${U}`,
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
      contract: `0xPP${U}`,
      wallet: "0xBB",
      token0: "0xCC",
      token1: "0xDD",
      fee: 500,
    };
    setCachedEpochs(key, {
      closedEpochs: [{ id: 1 }, { id: 2 }, { id: 3 }],
      liveEpoch: null,
    });
    setCachedEpochs(key, {
      closedEpochs: [{ id: 3 }],
      liveEpoch: { entryValue: 200 },
    });
    const got = getCachedEpochs(key);
    assert.strictEqual(got.closedEpochs.length, 3);
    assert.strictEqual(got.closedEpochs[0].id, 1);
    assert.strictEqual(got.closedEpochs[1].id, 2);
    assert.strictEqual(got.closedEpochs[2].id, 3);
  });

  it("stores and retrieves lifetime HODL amounts", () => {
    const {
      setCachedLifetimeHodl,
      getCachedLifetimeHodl,
    } = require("../src/epoch-cache");
    const key = {
      wallet: `0xABC${U}`,
      token0: "0xT0",
      token1: "0xT1",
      fee: 500,
    };
    assert.strictEqual(getCachedLifetimeHodl(key), null);
    setCachedLifetimeHodl(key, { amount0: 100, amount1: 200 });
    const got = getCachedLifetimeHodl(key);
    assert.strictEqual(got.amount0, 100);
    assert.strictEqual(got.amount1, 200);
  });

  it("stores and retrieves lastNftScanBlock", () => {
    const {
      setLastNftScanBlock,
      getLastNftScanBlock,
    } = require("../src/epoch-cache");
    const key = {
      wallet: `0xSB${U}`,
      token0: "0xT0",
      token1: "0xT1",
      fee: 500,
    };
    assert.strictEqual(getLastNftScanBlock(key), 0);
    setLastNftScanBlock(key, 12345);
    assert.strictEqual(getLastNftScanBlock(key), 12345);
  });
});
