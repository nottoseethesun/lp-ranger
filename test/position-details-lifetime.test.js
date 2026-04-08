/**
 * @file test/position-details-lifetime.test.js
 * @description Unit tests for pure helper functions in position-details.js
 *   (lifetime P&L path). Tests _extractSnap, _lifetimePnl,
 *   _resolveEntryValueCached, _buildDailyFallback, and _pickSmaller.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _extractSnap,
  _lifetimePnl,
  _resolveEntryValueCached,
  _buildDailyFallback,
  _pickSmaller,
} = require("../src/position-details");

// ── _pickSmaller ────────────────────────────────────────────────────

describe("_pickSmaller", () => {
  it("returns b when a is null", () => {
    assert.strictEqual(_pickSmaller(null, 5), 5);
  });

  it("returns a when b is null", () => {
    assert.strictEqual(_pickSmaller(3, null), 3);
  });

  it("returns b when a is undefined", () => {
    assert.strictEqual(_pickSmaller(undefined, -2), -2);
  });

  it("returns a when b is undefined", () => {
    assert.strictEqual(_pickSmaller(-1, undefined), -1);
  });

  it("returns the value closer to zero", () => {
    assert.strictEqual(_pickSmaller(-5, -2), -2);
    assert.strictEqual(_pickSmaller(10, 3), 3);
    assert.strictEqual(_pickSmaller(-1, 2), -1);
    assert.strictEqual(_pickSmaller(3, -2), -2);
  });

  it("returns a when both are equal", () => {
    assert.strictEqual(_pickSmaller(5, 5), 5);
    assert.strictEqual(_pickSmaller(-3, -3), -3);
  });

  it("handles zero values", () => {
    assert.strictEqual(_pickSmaller(0, 5), 0);
    assert.strictEqual(_pickSmaller(-3, 0), 0);
  });
});

// ── _resolveEntryValueCached ────────────────────────────────────────

describe("_resolveEntryValueCached", () => {
  it("returns deposit when set", () => {
    const cfg = {
      positions: {
        k1: { initialDepositUsd: 500, hodlBaseline: { entryValue: 300 } },
      },
    };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 500);
    assert.deepStrictEqual(baseline, { entryValue: 300 });
  });

  it("falls back to baseline entryValue when no deposit", () => {
    const cfg = {
      positions: {
        k1: { hodlBaseline: { entryValue: 300 } },
      },
    };
    const { entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 300);
  });

  it("returns 0 when no deposit and no baseline", () => {
    const cfg = { positions: {} };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 0);
    assert.strictEqual(baseline, null);
  });

  it("returns 0 when deposit is 0 and no baseline entryValue", () => {
    const cfg = {
      positions: {
        k1: { initialDepositUsd: 0, hodlBaseline: { entryValue: 0 } },
      },
    };
    const { entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 0);
  });

  it("returns deposit when baseline is null", () => {
    const cfg = {
      positions: { k1: { initialDepositUsd: 200 } },
    };
    const { baseline, entryValue } = _resolveEntryValueCached(cfg, "k1");
    assert.strictEqual(entryValue, 200);
    assert.strictEqual(baseline, null);
  });
});

// ── _extractSnap ────────────────────────────────────────────────────

describe("_extractSnap", () => {
  const cur = { priceGainLoss: 10, il: -5 };

  it("extracts from a full snapshot", () => {
    const snap = {
      totalFees: 20,
      totalGas: 3,
      priceChangePnl: 15,
      lifetimeIL: -8,
      firstEpochDateUtc: "2026-01-01",
      closedEpochs: [{ id: 1 }, { id: 2 }],
    };
    const r = _extractSnap(snap, cur, 5);
    assert.strictEqual(r.ltFees, 25); // totalFees + feesUsd
    assert.strictEqual(r.ltGas, 3);
    assert.strictEqual(r.ltPc, 15);
    assert.strictEqual(r.il, -8);
    assert.strictEqual(r.firstEpochDate, "2026-01-01");
    assert.strictEqual(r.rebalanceCount, 2);
  });

  it("falls back to cur values when snap is null", () => {
    const r = _extractSnap(null, cur, 7);
    assert.strictEqual(r.ltFees, 7);
    assert.strictEqual(r.ltGas, 0);
    assert.strictEqual(r.ltPc, 10);
    assert.strictEqual(r.il, -5);
    assert.strictEqual(r.firstEpochDate, null);
    assert.strictEqual(r.rebalanceCount, 0);
  });

  it("uses totalIL when lifetimeIL is missing", () => {
    const snap = {
      totalFees: 10,
      totalGas: 1,
      priceChangePnl: 5,
      totalIL: -3,
      closedEpochs: [],
    };
    const r = _extractSnap(snap, cur, 0);
    assert.strictEqual(r.il, -3);
  });

  it("uses cur.il when snap has no IL fields", () => {
    const snap = {
      totalFees: 0,
      totalGas: 0,
      priceChangePnl: 0,
      closedEpochs: [],
    };
    const r = _extractSnap(snap, { priceGainLoss: 0, il: -99 }, 0);
    assert.strictEqual(r.il, -99);
  });
});

// ── _buildDailyFallback ─────────────────────────────────────────────

describe("_buildDailyFallback", () => {
  it("returns snap.dailyPnl if present", () => {
    const daily = [{ date: "2026-03-01", feePnl: 1 }];
    const r = _buildDailyFallback({ dailyPnl: daily }, 100, 110, {});
    assert.strictEqual(r, daily);
  });

  it("returns null when entryValue is 0", () => {
    const r = _buildDailyFallback(null, 0, 110, {});
    assert.strictEqual(r, null);
  });

  it("builds single-day fallback from current data", () => {
    const r = _buildDailyFallback(null, 100, 120, { feesUsd: 5 });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].feePnl, 5);
    assert.strictEqual(r[0].gasCost, 0);
    assert.strictEqual(r[0].priceChangePnl, 20); // 120 - 100
    assert.ok(r[0].date.match(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("uses 0 for feePnl when body.feesUsd is missing", () => {
    const r = _buildDailyFallback(null, 50, 60, {});
    assert.strictEqual(r[0].feePnl, 0);
  });

  it("returns snap.dailyPnl over building fallback", () => {
    const daily = [{ date: "2026-01-01", feePnl: 99 }];
    const snap = { dailyPnl: daily };
    const r = _buildDailyFallback(snap, 100, 200, { feesUsd: 5 });
    assert.strictEqual(r, daily);
  });
});

// ── _lifetimePnl ────────────────────────────────────────────────────

describe("_lifetimePnl", () => {
  /** Create a minimal mock tracker. */
  function mockTracker(epochs, snapResult) {
    return {
      epochCount: () => epochs,
      snapshot: () => snapResult,
    };
  }

  it("computes lifetime P&L from tracker snapshot", () => {
    const snap = {
      totalFees: 10,
      totalGas: 2,
      priceChangePnl: 15,
      lifetimeIL: -5,
      firstEpochDateUtc: "2026-01-15",
      closedEpochs: [{ id: 1 }],
    };
    const tracker = mockTracker(1, snap);
    const cur = { priceGainLoss: 20, il: -3, profit: 7 };
    const ps = { price: 0.001 };
    // entryValue=100, currentValue=120
    const r = _lifetimePnl(tracker, ps, 100, cur, 5, 120);
    // ltPc = currentValue - entryValue = 120 - 100 = 20
    assert.strictEqual(r.ltPriceChange, 20);
    // ltFees = snap.totalFees + feesUsd = 10 + 5 = 15
    assert.strictEqual(r.ltFees, 15);
    assert.strictEqual(r.ltGas, 2);
    // ltNetPnl = ltPc + ltFees - ltGas = 20 + 15 - 2 = 33
    assert.strictEqual(r.ltNetPnl, 33);
    // il from snap = -5, ltProfit = ltFees - ltGas + il = 15 - 2 + (-5) = 8
    assert.strictEqual(r.ltProfit, 8);
    assert.strictEqual(r.firstEpochDate, "2026-01-15");
    assert.strictEqual(r.rebalanceCount, 1);
  });

  it("returns null ltNetPnl when entryValue is 0", () => {
    const snap = {
      totalFees: 5,
      totalGas: 1,
      priceChangePnl: 10,
      totalIL: -2,
      closedEpochs: [],
    };
    const tracker = mockTracker(1, snap);
    const cur = { priceGainLoss: null, il: null, profit: null };
    const r = _lifetimePnl(tracker, { price: 1 }, 0, cur, 3, 100);
    assert.strictEqual(r.ltNetPnl, null);
    // ltPc falls back to s.ltPc when entryValue is 0
    assert.strictEqual(r.ltPriceChange, 10);
  });

  it("uses cur.profit when no IL available", () => {
    const snap = {
      totalFees: 5,
      totalGas: 0,
      priceChangePnl: 0,
      closedEpochs: [],
    };
    const tracker = mockTracker(1, snap);
    const cur = { priceGainLoss: 0, il: null, profit: 42 };
    const r = _lifetimePnl(tracker, { price: 1 }, 100, cur, 0, 100);
    // il is null/undefined → ltProfit = cur.profit
    assert.strictEqual(r.ltProfit, 42);
  });

  it("handles zero-epoch tracker gracefully", () => {
    const tracker = mockTracker(0, null);
    const cur = { priceGainLoss: 5, il: -1, profit: 4 };
    const r = _lifetimePnl(tracker, { price: 1 }, 100, cur, 2, 110);
    assert.strictEqual(r.ltPriceChange, 10); // 110 - 100
    assert.strictEqual(r.ltFees, 2);
    assert.strictEqual(r.ltGas, 0);
    // il from cur = -1 → ltProfit = 2 - 0 + (-1) = 1
    assert.strictEqual(r.ltProfit, 1);
  });
});
