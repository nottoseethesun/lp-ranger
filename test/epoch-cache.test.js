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
  const _isolatedPath = path.join(TMP, `pnl-epochs-cache${U}.json`);

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    const mod = require("../src/epoch-cache");
    ({ getCachedEpochs, setCachedEpochs } = mod);
    mod._setCachePath(_isolatedPath);
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

  it("REGRESSION: round-trips liveEpoch when closedEpochs is a plain array", () => {
    /*- Earlier impl returned `liveEpoch: null` whenever
     *  `entry.closedEpochs` was a plain array (the standard format),
     *  silently dropping the sibling `entry.liveEpoch` written by
     *  setCachedEpochs.  pnl-tracker.restore then skipped live-epoch
     *  restoration, and bot-pnl-updater auto-opened a fresh epoch with
     *  `now` as openTime — making every historical compound fall
     *  outside the live window and rendering Current Fees Compounded
     *  as `—`.  This test pins the round-trip. */
    const key = {
      contract: `0xLIVE${U}`,
      wallet: "0xBB",
      token0: "0xCC",
      token1: "0xDD",
      fee: 500,
    };
    const liveEpoch = { entryValue: 1646.62, openTime: 1777593493902 };
    setCachedEpochs(key, {
      closedEpochs: [{ id: 1 }, { id: 2 }],
      liveEpoch,
    });
    const got = getCachedEpochs(key);
    assert.ok(got, "must hydrate cached entry");
    assert.ok(got.liveEpoch, "liveEpoch must round-trip, not be dropped");
    assert.strictEqual(got.liveEpoch.entryValue, 1646.62);
    assert.strictEqual(got.liveEpoch.openTime, 1777593493902);
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

  it("REGRESSION: setCachedEpochs preserves pool-scan sibling fields", () => {
    /*- The entry shares a cache slot with lifetimeHodlAmounts,
     *  freshDeposits, and lastNftScanBlock. An earlier impl did
     *  `cache[key] = {...value, cachedAt}` which silently nuked all
     *  three siblings on every epoch persist — re-breaking the
     *  lifetime-deposit UI on the next scan. This test pins the
     *  merge contract. */
    const {
      setCachedLifetimeHodl,
      getCachedLifetimeHodl,
      setLastNftScanBlock,
      getLastNftScanBlock,
      setCachedFreshDeposits,
      getCachedFreshDeposits,
    } = require("../src/epoch-cache");
    const key = {
      contract: `0xMERGE${U}`,
      wallet: "0xW",
      token0: "0xT0",
      token1: "0xT1",
      fee: 2500,
    };
    setCachedLifetimeHodl(key, {
      amount0: 1000,
      amount1: 2000,
      deposits: [{ raw0: "1", raw1: "2", block: 10 }],
    });
    setCachedFreshDeposits(key, {
      raw0: "1",
      raw1: "2",
      lastBlock: 26_000_000,
    });
    setLastNftScanBlock(key, 26_000_000);
    // Simulate epoch-reconstructor writing closed epochs — must NOT wipe
    // the three pool-scan fields set just above.
    setCachedEpochs(key, [{ id: 1, entryValue: 500 }]);
    assert.ok(
      getCachedLifetimeHodl(key),
      "lifetimeHodlAmounts must survive setCachedEpochs",
    );
    assert.strictEqual(getCachedLifetimeHodl(key).amount0, 1000);
    assert.ok(
      getCachedFreshDeposits(key),
      "freshDeposits must survive setCachedEpochs",
    );
    assert.strictEqual(
      getLastNftScanBlock(key),
      26_000_000,
      "lastNftScanBlock must survive setCachedEpochs",
    );
    // And the epoch actually landed.
    assert.strictEqual(getCachedEpochs(key).closedEpochs[0].id, 1);
  });

  it("setCachedEpochs grows closedEpochs monotonically across writes", () => {
    const key = {
      contract: `0xUP${U}`,
      wallet: "0xW",
      token0: "0xT0",
      token1: "0xT1",
      fee: 2500,
    };
    setCachedEpochs(key, [{ id: 1 }]);
    setCachedEpochs(key, [{ id: 1 }, { id: 2 }]);
    const got = getCachedEpochs(key);
    assert.strictEqual(got.closedEpochs.length, 2);
    assert.strictEqual(got.closedEpochs[1].id, 2);
  });
});
