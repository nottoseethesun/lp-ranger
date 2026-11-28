"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*-
 *  The cache file lives in a directory of this process's own under the
 *  system's temporary directory, never the project's tmp/, where the
 *  operator's caches are.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cache-test-"));

// Unique suffix prevents collisions when running concurrently with other suites.
const U = `-test-${process.pid}`;

describe("epoch-cache", () => {
  let getCachedEpochs, setCachedEpochs;
  const _isolatedPath = path.join(TMP, `pnl-epochs-cache${U}.json`);

  before(() => {
    const mod = require("../src/bot/epoch-cache");
    ({ getCachedEpochs, setCachedEpochs } = mod);
    mod._setCachePath(_isolatedPath);
  });

  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
    } = require("../src/bot/epoch-cache");
    const key = {
      contract: `0xHODL${U}`,
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

  it("REGRESSION: setCachedEpochs preserves pool-scan sibling fields", () => {
    /*-
     *  The entry shares a cache slot with lifetimeHodlAmounts and
     *  freshDeposits. A plain `cache[key] = {...value, cachedAt}` would
     *  wipe both siblings on every epoch persist, which breaks the
     *  lifetime-deposit UI on the next scan. This test pins the merge
     *  contract.
     */
    const {
      setCachedLifetimeHodl,
      getCachedLifetimeHodl,
      setCachedFreshDeposits,
      getCachedFreshDeposits,
    } = require("../src/bot/epoch-cache");
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
    /*-
     *  Simulate epoch-reconstructor writing closed epochs — must NOT wipe
     *  the two pool-scan fields set just above.
     */
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

  it("clearCacheEntry deletes every field cached under a pool's key", () => {
    /*-
     *  Reload Current Position depends on this: closedEpochs, liveEpoch,
     *  lifetimeHodlAmounts and freshDeposits all must go, so the fresh
     *  scan recomputes them with nothing stale merged in.
     */
    const {
      clearCacheEntry,
      setCachedLifetimeHodl,
      getCachedLifetimeHodl,
      setCachedFreshDeposits,
      getCachedFreshDeposits,
    } = require("../src/bot/epoch-cache");
    const key = {
      contract: `0xCLR${U}`,
      wallet: "0xCLRWALLET",
      token0: "0xC0",
      token1: "0xC1",
      fee: 500,
    };
    setCachedEpochs(key, {
      closedEpochs: [{ id: 1 }],
      liveEpoch: { entryValue: 100 },
    });
    setCachedLifetimeHodl(key, { amount0: 1, amount1: 2 });
    setCachedFreshDeposits(key, { raw0: "1", raw1: "2", lastBlock: 42 });
    /*- Sanity: everything present before clear. */
    assert.ok(getCachedEpochs(key));
    assert.ok(getCachedLifetimeHodl(key));
    assert.ok(getCachedFreshDeposits(key));
    clearCacheEntry(key);
    /*- Every field gone after clear. */
    assert.strictEqual(getCachedEpochs(key), null);
    assert.strictEqual(getCachedLifetimeHodl(key), null);
    assert.strictEqual(getCachedFreshDeposits(key), null);
  });

  it("keeps every pool's entries whole when a write is cut short, as on a full disk", () => {
    const { _setSinkForTests } = require("../src/lib/log");
    const pool = (n) => ({
      contract: `0xCUT${n}${U}`,
      wallet: "0xW",
      token0: "0xT0",
      token1: "0xT1",
      fee: 500,
    });
    setCachedEpochs(pool(1), {
      closedEpochs: [{ entryValue: 1 }],
      liveEpoch: null,
    });
    setCachedEpochs(pool(2), {
      closedEpochs: [{ entryValue: 2 }],
      liveEpoch: null,
    });
    const errors = [];
    const restoreLog = _setSinkForTests({
      log: () => {},
      warn: () => {},
      error: (...a) => errors.push(a.join(" ")),
    });
    /*-
     *  TEST-ONLY global swap: fs.writeFileSync, put back in the `finally`.
     *  It writes part of the text and then fails, as a full disk does; the
     *  epoch cache has no seam for its file system.
     */
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = (p, data, ...rest) => {
      realWrite(p, String(data).slice(0, 10), ...rest);
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    };
    try {
      setCachedEpochs(pool(1), {
        closedEpochs: [{ entryValue: 1 }, { entryValue: 9 }],
        liveEpoch: null,
      });
    } finally {
      fs.writeFileSync = realWrite;
      restoreLog();
    }
    assert.ok(
      errors.some((e) => e.includes("could not write to")),
      "the failure is told",
    );
    assert.strictEqual(
      getCachedEpochs(pool(1)).closedEpochs.length,
      1,
      "the pool as last written",
    );
    assert.strictEqual(
      getCachedEpochs(pool(2)).closedEpochs[0].entryValue,
      2,
      "the other pool kept",
    );
  });

  it("writes nothing over a cache it cannot read, so no save while LP Ranger stops wipes the other pools", () => {
    /*-
     *  A cache that cannot be read is told, which stops LP Ranger; the
     *  stop waits for a move under way, and a save meanwhile would write
     *  its own pool alone over every other pool's history. The handler a
     *  program sets (its stop) and the log are stand-ins, put back in the
     *  `finally`, which also removes the damaged file.
     */
    const {
      setCachedLifetimeHodl,
      clearCacheEntry,
    } = require("../src/bot/epoch-cache");
    const { handleFileProblemsWith } = require("../src/lib/file-problem");
    const { _setSinkForTests } = require("../src/lib/log");
    const pool = {
      contract: `0xBAD${U}`,
      wallet: "0xW",
      token0: "0xT0",
      token1: "0xT1",
      fee: 500,
    };
    const damaged = '{ "cut short';
    fs.writeFileSync(_isolatedPath, damaged);
    const told = [];
    handleFileProblemsWith((words) => told.push(words));
    const restoreLog = _setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
    try {
      setCachedEpochs(pool, {
        closedEpochs: [{ entryValue: 5 }],
        liveEpoch: null,
      });
      setCachedLifetimeHodl(pool, { amount0: 1, amount1: 2 });
      clearCacheEntry(pool);
      assert.equal(
        fs.readFileSync(_isolatedPath, "utf8"),
        damaged,
        "left as it was",
      );
      assert.ok(told.length >= 1, "told");
      assert.match(told[0], /: it is not valid JSON \(/);
      assert.equal(getCachedEpochs(pool), null, "read as empty");
    } finally {
      handleFileProblemsWith(null);
      restoreLog();
      fs.rmSync(_isolatedPath, { force: true });
    }
  });

  it("clearCacheEntry is a no-op when the key is not present", () => {
    const { clearCacheEntry } = require("../src/bot/epoch-cache");
    /*- Must not throw. */
    clearCacheEntry({
      contract: `0xNONE${U}`,
      wallet: "0xW",
      token0: "0xN0",
      token1: "0xN1",
      fee: 500,
    });
  });
});
