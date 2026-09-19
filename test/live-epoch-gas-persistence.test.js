/**
 * @file test/live-epoch-gas-persistence.test.js
 * @description
 * Gas charged to the period a position is in RIGHT NOW has to survive a
 * restart, and has to survive it exactly once.
 *
 * Every other figure on a live epoch is re-derived on the next poll —
 * entry value from the NFT's mint, fees and compounded coins from the
 * chain — so losing those costs nothing. Gas is the exception: it only
 * accumulates, so a charge that is not written down is gone.
 *
 * Three guarantees, one per defect these were written against:
 *   1. Cancel-TX gas reaches the cache when it is charged. Nothing else
 *      saves it — a cancel means the rebalance did NOT happen, so no
 *      epoch closes behind it.
 *   2. A reconstruction does not erase the live epoch on its way past.
 *   3. The chain's past compound gas, which the lifetime scan re-offers
 *      on every restart, is written rather than added — and stays out
 *      of the Per-Day rows, which are per-day.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");

const { createPnlTracker } = require("../src/pnl-tracker");

const TMP = path.join(process.cwd(), "tmp");
/*- Unique per process: the suite runs concurrently with others that
 *  touch the same cache file. Matches test/epoch-cache.test.js. */
const U = `-test-live-gas-${process.pid}`;

/** Open a live epoch with the shape the bot opens one with. */
function openLive(tracker, over = {}) {
  tracker.openEpoch({
    entryValue: 1000,
    entryPrice: 0.001,
    lowerPrice: 0.0005,
    upperPrice: 0.002,
    ...over,
  });
  return tracker;
}

describe("cancel-TX gas reaches the cache", () => {
  const _origRequire = Module.prototype.require;
  let _recordCancelGas;

  before(() => {
    /*- `actualGasCostUsd` is destructured into bot-cycle at require
     *  time, so the only seam is the require itself. Same approach as
     *  test/gas-historical-price-fallback.test.js. */
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        const real = _origRequire.call(this, id);
        return { ...real, actualGasCostUsd: async () => 0.25 };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-cycle")];
    ({ _recordCancelGas } = require("../src/bot-cycle"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-cycle")];
  });

  it("writes the tracker out when it charges the gas", async () => {
    const tracker = openLive(createPnlTracker());
    const writes = [];
    await _recordCancelGas(
      { cancelGasCostWei: 21_000_000_000_000_000n },
      { _pnlTracker: tracker, updateBotState: (p) => writes.push(p) },
    );

    const saved = writes.filter((w) => w.pnlEpochs);
    assert.equal(
      saved.length,
      1,
      "the charge must be written out — nothing else saves it, because no epoch closes behind a cancel",
    );
    assert.ok(
      saved[0].pnlEpochs.liveEpoch.gas > 0,
      "the written-out state must carry the gas, not an empty epoch",
    );
  });

  it("writes nothing when there was no cancel charge", async () => {
    const tracker = openLive(createPnlTracker());
    const writes = [];
    await _recordCancelGas(
      { cancelGasCostWei: 0n },
      { _pnlTracker: tracker, updateBotState: (p) => writes.push(p) },
    );
    assert.equal(writes.length, 0, "no charge, no write");
  });
});

describe("a reconstruction keeps the live epoch", () => {
  const _isolatedPath = path.join(TMP, `pnl-epochs-cache${U}.json`);
  let getCachedEpochs;
  let _mergeAndPersist;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    const cache = require("../src/epoch-cache");
    cache._setCachePath(_isolatedPath);
    ({ getCachedEpochs } = cache);
    ({ _mergeAndPersist } = require("../src/epoch-reconstructor"));
  });

  after(() => {
    fs.rmSync(_isolatedPath, { force: true });
    require("../src/epoch-cache")._setCachePath(
      path.join(TMP, "pnl-epochs-cache.json"),
    );
  });

  it("stores the live epoch's gas, not a null in its place", () => {
    const key = {
      contract: `0xCC05${U}`,
      wallet: "0xWallet",
      token0: "0xT0",
      token1: "0xT1",
      fee: 2500,
    };
    const tracker = createPnlTracker();
    openLive(tracker);
    tracker.addGas(4.5, 400);
    tracker.addGas(1.25, 100);
    const live = tracker.getLiveEpoch();

    _mergeAndPersist(createPnlTracker(), [], live, null, key);

    const back = getCachedEpochs(key);
    assert.ok(back, "cache entry must exist");
    assert.ok(
      back.liveEpoch,
      "the live epoch must survive the reconstruction — a null here erases gas that exists nowhere else",
    );
    assert.equal(
      back.liveEpoch.gas,
      5.75,
      "its gas must come back intact — the cancel and compound charges nothing else saves",
    );
  });
});

describe("the chain's past compound gas does not become today's gas", () => {
  /*- The lifetime scan recovers every compound the position ever made
   *  and hands over one total. It is months of charges; the open period
   *  merely happened to be open when the scan finished. Counting it as
   *  that period's gas reports a position's lifetime cost as one day's.
   *  And the scan re-offers the same total on every restart and every
   *  Re-scan Prices, so the total is written rather than added. */

  it("keeps it out of the open period's own gas", () => {
    const t = openLive(createPnlTracker());
    t.addGas(0.5, 40); // a charge that really is today's
    t.setImportedGas(2.27, 197000);
    const live = t.getLiveEpoch();
    assert.equal(live.gas, 0.5, "today's row shows only today's charge");
    assert.equal(live.importedGas, 2.27, "the history is held apart");
  });

  it("still counts it in the lifetime total", () => {
    const t = openLive(createPnlTracker());
    t.addGas(0.5, 40);
    t.setImportedGas(2.27, 197000);
    const snap = t.snapshot(0.001);
    assert.ok(
      Math.abs(snap.totalGas - 2.77) < 1e-9,
      `lifetime gas must include it, got ${snap.totalGas}`,
    );
    assert.equal(snap.totalGasNative, 197040);
  });

  it("leaves the Per-Day rows carrying only same-day charges", () => {
    const t = openLive(createPnlTracker());
    t.addGas(0.5, 40);
    t.setImportedGas(2.27, 197000);
    const rows = t.snapshot(0.001).dailyPnl.filter((d) => d.gasCost > 0);
    for (const r of rows)
      assert.ok(
        r.gasCost < 2.27,
        `no row may carry the imported total, got ${r.gasCost}`,
      );
    const summed = rows.reduce((s, r) => s + r.gasCost, 0);
    assert.ok(
      Math.abs(summed - 0.5) < 1e-9,
      `the table shows today's charge only, got ${summed}`,
    );
  });

  it("refuses a second offer of the same total", () => {
    const t = openLive(createPnlTracker());
    assert.equal(t.setImportedGas(2.27, 197000), true);
    assert.equal(t.setImportedGas(2.27, 197000), false, "re-scan offers again");
    assert.ok(Math.abs(t.snapshot(0.001).totalGas - 2.27) < 1e-9);
  });

  it("refuses it again after a save and restore", () => {
    const first = openLive(createPnlTracker());
    first.setImportedGas(2.27, 197000);
    const onDisk = JSON.parse(JSON.stringify(first.serialize()));
    const second = createPnlTracker();
    second.restore(onDisk);
    assert.equal(
      second.setImportedGas(2.27, 197000),
      false,
      "a restart must not buy the position's history twice",
    );
    assert.ok(Math.abs(second.snapshot(0.001).totalGas - 2.27) < 1e-9);
  });
});
