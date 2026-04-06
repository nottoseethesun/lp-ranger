/**
 * @file test/pnl-tracker.test.js
 * @description Unit tests for the pnl-tracker module (lifecycle, P&L math, epochs, daily P&L).
 * IL calculator tests are in test/il-calculator.test.js.
 * Run with: npm test
 */

"use strict";
const { describe, it } = require("node:test");

const assert = require("assert");
const { createPnlTracker } = require("../src/pnl-tracker");

// ── createPnlTracker — basic lifecycle ───────────────────────────────────────

describe("createPnlTracker — lifecycle", () => {
  it("starts with no epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    assert.strictEqual(tracker.epochCount(), 0);
  });

  it("opens an epoch and reflects it in snapshot", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    tracker.openEpoch({
      entryValue: 2000,
      entryPrice: 0.00042,
      lowerPrice: 0.000336,
      upperPrice: 0.000504,
    });
    const snap = tracker.snapshot(0.00042);
    assert.ok(snap.liveEpoch !== null);
    assert.strictEqual(snap.liveEpoch.id, 1);
    assert.strictEqual(snap.closedEpochs.length, 0);
  });

  it("throws if openEpoch is called while one is already open", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    tracker.openEpoch({
      entryValue: 2000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    assert.throws(
      () =>
        tracker.openEpoch({
          entryValue: 100,
          entryPrice: 1,
          lowerPrice: 0.9,
          upperPrice: 1.1,
        }),
      /already open/i,
    );
  });

  it("closes an epoch and moves it to closedEpochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    tracker.openEpoch({
      entryValue: 2000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.closeEpoch({ exitValue: 2050, gasCost: 0.5 });
    const snap = tracker.snapshot();
    assert.strictEqual(snap.closedEpochs.length, 1);
    assert.strictEqual(snap.liveEpoch, null);
  });

  it("throws if closeEpoch is called with no open epoch", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    assert.throws(
      () => tracker.closeEpoch({ exitValue: 100, gasCost: 0 }),
      /no open epoch/i,
    );
  });

  it("epoch count increments correctly across multiple epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 2000 });
    tracker.openEpoch({
      entryValue: 2000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.closeEpoch({ exitValue: 2000, gasCost: 0.1 });
    tracker.openEpoch({
      entryValue: 2000,
      entryPrice: 1.1,
      lowerPrice: 0.88,
      upperPrice: 1.32,
    });
    assert.strictEqual(tracker.epochCount(), 2);
  });
});

// ── P&L calculations ──────────────────────────────────────────────────────────

describe("createPnlTracker — P&L math", () => {
  it("epochPnl = exitValue − entryValue + fees − il − gas", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 10 });
    tracker.closeEpoch({ exitValue: 1005, gasCost: 0.5 });

    const ep = tracker.snapshot().closedEpochs[0];
    // IL at price ratio 1 = 0, gas = 0.5 (open) + 0.5 (close) = 0.5
    // epochPnl = (1005 - 1000) + 10 - 0 - 0.5 = 14.5
    assert.ok(
      Math.abs(ep.epochPnl - 14.5) < 0.01,
      `expected ≈14.5, got ${ep.epochPnl}`,
    );
  });

  it("cumulativePnl sums closed + live epoch P&L", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    // Epoch 1: +5
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.closeEpoch({ exitValue: 1005, gasCost: 0 });
    // Epoch 2: open, live fees +3
    tracker.openEpoch({
      entryValue: 1005,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 3 });

    const snap = tracker.snapshot(1);
    // closedPnl = 5, livePnl ≈ fees only at same price = 3
    assert.ok(snap.cumulativePnl > 5, "cumulative should include live fees");
  });

  it("totalFees accumulates across epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });

    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 });
    tracker.closeEpoch({ exitValue: 1000, gasCost: 0 });

    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 7 });

    const snap = tracker.snapshot(1);
    assert.ok(
      Math.abs(snap.totalFees - 12) < 0.01,
      `expected totalFees ≈ 12, got ${snap.totalFees}`,
    );
  });

  it("netReturn = totalFees − totalIL − totalGas", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 20 });
    tracker.closeEpoch({ exitValue: 1000, gasCost: 2 });

    const snap = tracker.snapshot(1);
    assert.ok(
      Math.abs(
        snap.netReturn - (snap.totalFees - snap.totalIL - snap.totalGas),
      ) < 0.001,
    );
  });

  it("snapshot returns initialDeposit correctly", () => {
    const tracker = createPnlTracker({ initialDeposit: 5000 });
    tracker.openEpoch({
      entryValue: 5000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    assert.strictEqual(tracker.snapshot(1).initialDeposit, 5000);
  });
});

// ── updateLiveEpoch ───────────────────────────────────────────────────────────

describe("createPnlTracker — updateLiveEpoch", () => {
  it("silently does nothing when no epoch is open", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    assert.doesNotThrow(() =>
      tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 }),
    );
  });

  it("updates fees on the live epoch", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 9.99 });
    assert.ok(Math.abs(tracker.snapshot(1).liveEpoch.fees - 9.99) < 0.001);
  });

  it("snapshot does not expose internal liveEpoch object directly", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    const snap1 = tracker.snapshot(1);
    snap1.liveEpoch.fees = 9999;
    const snap2 = tracker.snapshot(1);
    assert.ok(snap2.liveEpoch.fees !== 9999, "snapshot should be a copy");
  });
});

// ── epoch colours ─────────────────────────────────────────────────────────────

describe("createPnlTracker — epoch colours", () => {
  it("assigns distinct colours to the first 10 epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 100 });
    const colours = new Set();
    for (let i = 0; i < 10; i++) {
      tracker.openEpoch({
        entryValue: 100,
        entryPrice: 1,
        lowerPrice: 0.8,
        upperPrice: 1.2,
      });
      const snap = tracker.snapshot(1);
      colours.add(snap.liveEpoch.color);
      tracker.closeEpoch({ exitValue: 100, gasCost: 0 });
    }
    assert.strictEqual(colours.size, 10, "all 10 colours should be unique");
  });
});

// ── P&L breakdown: price-change vs fees ──────────────────────────────────

describe("createPnlTracker — P&L breakdown", () => {
  it("snapshot includes priceChangePnl and feePnl", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 15 });
    tracker.closeEpoch({ exitValue: 1010, gasCost: 1 });

    const snap = tracker.snapshot();
    assert.ok("priceChangePnl" in snap, "should have priceChangePnl");
    assert.ok("feePnl" in snap, "should have feePnl");
  });

  it("priceChangePnl reflects value change excluding fees", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1.5, feesAccrued: 20 });
    tracker.closeEpoch({ exitValue: 1050, gasCost: 0 });

    const snap = tracker.snapshot();
    const ep = snap.closedEpochs[0];
    // priceChangePnl = exitValue - entryValue - fees = 1050 - 1000 - 20 = 30
    assert.strictEqual(ep.priceChangePnl, 30);
    assert.strictEqual(ep.feePnl, 20);
  });

  it("feePnl equals totalFees in snapshot", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 25 });
    tracker.closeEpoch({ exitValue: 1025, gasCost: 0 });

    const snap = tracker.snapshot();
    assert.strictEqual(snap.feePnl, snap.totalFees);
    assert.strictEqual(snap.feePnl, 25);
  });

  it("live epoch tracks priceChangePnl on update", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 0.8, feesAccrued: 5 });

    const snap = tracker.snapshot(0.8);
    assert.ok(
      snap.liveEpoch.priceChangePnl < 0,
      "price-change P&L should be negative when price drops",
    );
    assert.strictEqual(snap.liveEpoch.feePnl, 5);
  });

  it("cumulative priceChangePnl sums across epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });

    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 10 });
    tracker.closeEpoch({ exitValue: 1020, gasCost: 0 });
    // priceChangePnl = 1020 - 1000 - 10 = 10

    tracker.openEpoch({
      entryValue: 1020,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 });
    tracker.closeEpoch({ exitValue: 1000, gasCost: 0 });
    // priceChangePnl = 1000 - 1020 - 5 = -25

    const snap = tracker.snapshot();
    assert.strictEqual(snap.priceChangePnl, 10 + -25);
    assert.strictEqual(snap.feePnl, 15); // 10 + 5
  });

  it("records historical token prices on epoch", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 0.00042,
      lowerPrice: 0.000336,
      upperPrice: 0.000504,
      token0UsdPrice: 0.00042,
      token1UsdPrice: 1.0,
    });
    tracker.closeEpoch({
      exitValue: 1050,
      gasCost: 0.5,
      token0UsdPrice: 0.0005,
      token1UsdPrice: 1.02,
    });

    const ep = tracker.snapshot().closedEpochs[0];
    assert.strictEqual(ep.token0UsdEntry, 0.00042);
    assert.strictEqual(ep.token1UsdEntry, 1.0);
    assert.strictEqual(ep.token0UsdExit, 0.0005);
    assert.strictEqual(ep.token1UsdExit, 1.02);
  });
});

// ── Per-day P&L ──────────────────────────────────────────────────────────────

describe("createPnlTracker — daily P&L", () => {
  it("snapshot includes dailyPnl array", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const snap = tracker.snapshot();
    assert.ok(Array.isArray(snap.dailyPnl));
  });

  it("dailyPnl aggregates epochs by close date", () => {
    const day1 = new Date("2025-01-15T10:00:00Z").getTime();
    const day2 = new Date("2025-01-16T14:00:00Z").getTime();

    const tracker = createPnlTracker({
      initialDeposit: 1000,
      nowFn: () => day1,
    });

    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: day1,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 10 });
    tracker.closeEpoch({ exitValue: 1020, gasCost: 1, closeTime: day1 });

    tracker.openEpoch({
      entryValue: 1020,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: day2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 });
    tracker.closeEpoch({ exitValue: 1030, gasCost: 0.5, closeTime: day2 });

    const snap = tracker.snapshot();
    assert.strictEqual(snap.dailyPnl.length, 2);

    // Newest first
    const newest = snap.dailyPnl[0];
    assert.strictEqual(newest.date, "2025-01-16");
    assert.strictEqual(newest.feePnl, 5);
    assert.strictEqual(newest.priceChangePnl, 5);
    assert.strictEqual(newest.gasCost, 0.5);
  });

  it("dailyPnl computes running cumulative", () => {
    const day1 = new Date("2025-03-01T12:00:00Z").getTime();
    const day2 = new Date("2025-03-02T12:00:00Z").getTime();

    const tracker = createPnlTracker({ initialDeposit: 1000 });

    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: day1,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 10 });
    tracker.closeEpoch({ exitValue: 1010, gasCost: 0, closeTime: day1 });

    tracker.openEpoch({
      entryValue: 1010,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: day2,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 });
    tracker.closeEpoch({ exitValue: 1015, gasCost: 0, closeTime: day2 });

    const snap = tracker.snapshot();
    // Newest entry has higher cumulative (or equal)
    const oldest = snap.dailyPnl[snap.dailyPnl.length - 1];
    const newest = snap.dailyPnl[0];
    assert.ok(newest.cumulative >= oldest.cumulative);
  });

  it("dailyPnl includes all days when no limit", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const baseDate = new Date("2025-01-01T12:00:00Z");

    for (let d = 0; d < 35; d++) {
      const ts = baseDate.getTime() + d * 86_400_000;
      tracker.openEpoch({
        entryValue: 1000,
        entryPrice: 1,
        lowerPrice: 0.8,
        upperPrice: 1.2,
        openTime: ts,
      });
      tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 1 });
      tracker.closeEpoch({ exitValue: 1001, gasCost: 0, closeTime: ts });
    }

    const snap = tracker.snapshot();
    assert.strictEqual(
      snap.dailyPnl.length,
      35,
      `expected 35, got ${snap.dailyPnl.length}`,
    );
  });

  it("each DailyPnl has netPnl = priceChangePnl + feePnl - gasCost", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const ts = new Date("2025-06-01T12:00:00Z").getTime();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: ts,
    });
    tracker.updateLiveEpoch({ currentPrice: 1, feesAccrued: 5 });
    tracker.closeEpoch({ exitValue: 1010, gasCost: 2, closeTime: ts });

    const snap = tracker.snapshot();
    const day = snap.dailyPnl[0];
    assert.strictEqual(
      day.netPnl,
      day.priceChangePnl + day.feePnl - day.gasCost,
    );
  });
});

// ── Snapshot date range ─────────────────────────────────────────────────────

describe("snapshot — date range fields", () => {
  it("returns firstEpochDateUtc and snapshotDateUtc for closed epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const ts1 = new Date("2024-03-15T10:00:00Z").getTime();
    const ts2 = new Date("2024-06-20T10:00:00Z").getTime();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: ts1,
    });
    tracker.closeEpoch({
      exitValue: 1050,
      gasCost: 1,
      closeTime: ts1 + 86400000,
    });
    tracker.openEpoch({
      entryValue: 1050,
      entryPrice: 1.05,
      lowerPrice: 0.8,
      upperPrice: 1.3,
      openTime: ts2,
    });
    tracker.closeEpoch({
      exitValue: 1100,
      gasCost: 1,
      closeTime: ts2 + 86400000,
    });

    const snap = tracker.snapshot();
    assert.strictEqual(snap.firstEpochDateUtc, "2024-03-15");
    assert.strictEqual(
      snap.snapshotDateUtc,
      new Date().toISOString().slice(0, 10),
    );
  });

  it("returns null firstEpochDateUtc when no epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const snap = tracker.snapshot();
    assert.strictEqual(snap.firstEpochDateUtc, null);
    assert.strictEqual(typeof snap.snapshotDateUtc, "string");
  });

  it("uses live epoch openTime when no closed epochs", () => {
    const tracker = createPnlTracker({ initialDeposit: 1000 });
    const ts = new Date("2025-01-10T08:00:00Z").getTime();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: ts,
    });
    const snap = tracker.snapshot(1.0);
    assert.strictEqual(snap.firstEpochDateUtc, "2025-01-10");
  });
});
