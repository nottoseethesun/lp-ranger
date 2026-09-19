/**
 * @file test/live-epoch-gas-persistence.test.js
 * @description
 * Gas charged to the period a position is in RIGHT NOW has to survive a
 * restart, and has to survive it exactly once.
 *
 * Every other figure on a live epoch is re-derived on the next poll —
 * entry value from the NFT's mint, fees and compounded coins from the
 * chain — so losing those costs nothing. Gas is the exception: it only
 * accumulates. A charge that is not written down is gone, and a charge
 * that comes back without its "already counted" mark is counted twice.
 *
 * Three guarantees, one per defect these were written against:
 *   1. Cancel-TX gas reaches the cache when it is charged. Nothing else
 *      saves it — a cancel means the rebalance did NOT happen, so no
 *      epoch closes behind it.
 *   2. A reconstruction does not erase the live epoch on its way past.
 *   3. The NFT's mint gas is taken up once per epoch across any number
 *      of restarts, and is valued at the mint rather than at today.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
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
    tracker.addMintGas(1.25, 100);
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
      "its gas must come back intact (cancel/compound charges plus mint)",
    );
    assert.equal(
      back.liveEpoch.mintGasApplied,
      true,
      "and its already-counted mark, or the mint charge is added again on restore",
    );
  });
});

describe("mint gas is taken up once per epoch", () => {
  it("refuses a second offer of the same charge", () => {
    const tracker = openLive(createPnlTracker());
    assert.equal(tracker.addMintGas(2, 100), true, "first offer is taken");
    assert.equal(tracker.addMintGas(2, 100), false, "second is refused");
    assert.equal(
      tracker.snapshot(0.001).totalGas,
      2,
      "the charge appears once, not twice",
    );
  });

  it("refuses it again after a save and restore", () => {
    const first = openLive(createPnlTracker());
    first.addMintGas(2, 100);
    /*- The restart: serialize to disk shape, JSON round-trip, restore
     *  into the fresh process's tracker. */
    const onDisk = JSON.parse(JSON.stringify(first.serialize()));

    const second = createPnlTracker();
    second.restore(onDisk);
    assert.equal(
      second.addMintGas(2, 100),
      false,
      "the mark must travel with the charge — this is the double-count",
    );
    assert.equal(second.snapshot(0.001).totalGas, 2, "still one charge");
  });

  it("accepts the new NFT's charge after a rebalance closes the epoch", () => {
    const tracker = openLive(createPnlTracker());
    tracker.addMintGas(2, 100);
    tracker.closeEpoch({ exitValue: 1000, gasCost: 0, currentPrice: 0.001 });
    openLive(tracker);
    assert.equal(
      tracker.addMintGas(3, 150),
      true,
      "each NFT's mint gas belongs to the epoch that NFT opened",
    );
  });

  it("does nothing when no epoch is open", () => {
    assert.equal(createPnlTracker().addMintGas(2, 100), false);
  });
});

describe("mint gas is valued at the mint, not at today", () => {
  const _origRequire = Module.prototype.require;
  let _applyMintGas;
  let _asked;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./historical-token-price")
        return {
          fetchHistoricalTokenPriceUsd: async (_token, opts) => {
            _asked.push(opts);
            return 0.001;
          },
        };
      if (id === "./price-fetcher") {
        const real = _origRequire.call(this, id);
        /*- Today's price sits far from the historical one, so the
         *  resulting figure itself says which source was used. */
        return { ...real, fetchTokenPriceUsd: async () => 99 };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-pnl-updater")];
    ({ _applyMintGas } = require("../src/bot-pnl-updater"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-pnl-updater")];
  });

  beforeEach(() => {
    _asked = [];
  });

  const baselineDeps = () => ({
    _botState: {
      hodlBaseline: {
        mintGasWei: "1000000000000000000", // 1.0 native
        mintTimestamp: 1_718_948_855,
        mintDate: "2024-06-21",
      },
    },
  });

  it("prices the charge at the baseline's mintTimestamp", async () => {
    const tracker = openLive(createPnlTracker());
    await _applyMintGas(baselineDeps(), tracker);

    assert.equal(_asked.length, 1, "the historical source must be consulted");
    assert.equal(_asked[0].timestamp, 1_718_948_855, "at the mint's moment");
    assert.ok(
      Math.abs(tracker.snapshot(0.001).totalGas - 0.001) < 1e-9,
      `must be valued at the mint-day price, got ${tracker.snapshot(0.001).totalGas}`,
    );
  });

  it("does not re-add the charge on a later poll", async () => {
    const tracker = openLive(createPnlTracker());
    const deps = baselineDeps();
    await _applyMintGas(deps, tracker);
    await _applyMintGas(deps, tracker);
    await _applyMintGas(deps, tracker);
    assert.ok(
      Math.abs(tracker.snapshot(0.001).totalGas - 0.001) < 1e-9,
      "three polls, one charge",
    );
  });

  it("does not re-add it in a fresh process that restored the epoch", async () => {
    const first = openLive(createPnlTracker());
    await _applyMintGas(baselineDeps(), first);
    const onDisk = JSON.parse(JSON.stringify(first.serialize()));

    const second = createPnlTracker();
    second.restore(onDisk);
    await _applyMintGas(baselineDeps(), second);
    assert.ok(
      Math.abs(second.snapshot(0.001).totalGas - 0.001) < 1e-9,
      "a restart must not buy the same mint gas twice",
    );
  });

  it("falls back to today's price when the baseline has no timestamp", async () => {
    const tracker = openLive(createPnlTracker());
    const deps = baselineDeps();
    delete deps._botState.hodlBaseline.mintTimestamp;
    await _applyMintGas(deps, tracker);
    assert.equal(_asked.length, 0, "nothing to ask the historical source");
    assert.ok(
      Math.abs(tracker.snapshot(0.001).totalGas - 99) < 1e-9,
      "valued at today rather than skipped — a gas figure of zero reads as free",
    );
  });
});

describe("the chain's past compound gas does not become today's gas", () => {
  /*- The lifetime scan recovers every compound the position ever made
   *  and hands over one total. It is months of charges; the open period
   *  merely happened to be open when the scan finished. Counting it as
   *  that period's gas reports a position's lifetime cost as one day's.
   *  And the scan re-offers the same total on every restart and every
   *  Re-scan Prices, so without a mark it accumulates. */

  it("keeps it out of the open period's own gas", () => {
    const t = openLive(createPnlTracker());
    t.addGas(0.5, 40); // a charge that really is today's
    t.addImportedGas(2.27, 197000);
    const live = t.getLiveEpoch();
    assert.equal(live.gas, 0.5, "today's row shows only today's charge");
    assert.equal(live.importedGas, 2.27, "the history is held apart");
  });

  it("still counts it in the lifetime total", () => {
    const t = openLive(createPnlTracker());
    t.addGas(0.5, 40);
    t.addImportedGas(2.27, 197000);
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
    t.addImportedGas(2.27, 197000);
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
    assert.equal(t.addImportedGas(2.27, 197000), true);
    assert.equal(t.addImportedGas(2.27, 197000), false, "re-scan offers again");
    assert.ok(Math.abs(t.snapshot(0.001).totalGas - 2.27) < 1e-9);
  });

  it("refuses it again after a save and restore", () => {
    const first = openLive(createPnlTracker());
    first.addImportedGas(2.27, 197000);
    const onDisk = JSON.parse(JSON.stringify(first.serialize()));
    const second = createPnlTracker();
    second.restore(onDisk);
    assert.equal(
      second.addImportedGas(2.27, 197000),
      false,
      "a restart must not buy the position's history twice",
    );
    assert.ok(Math.abs(second.snapshot(0.001).totalGas - 2.27) < 1e-9);
  });
});
