/**
 * @file test/pnl-daily.test.js
 * @description Tests for daily P&L cumulative calculation with residuals.
 * Split from pnl-tracker.test.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { createPnlTracker } = require("../src/pnl-tracker");

describe("dailyPnl cumulative includes residuals for telescoping", () => {
  it("residuals bridge epoch gaps in the cumulative", () => {
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: "2025-06-01T12:00:00Z",
    });
    tracker.closeEpoch({
      exitValue: 110,
      gasCost: 0.5,
      token0UsdPrice: 1.1,
      token1UsdPrice: 1,
      closeTime: "2025-06-01T12:00:00Z",
    });
    // Epoch 2 entry > epoch 1 exit → positive residual (120 − 110 = 10)
    tracker.openEpoch({
      entryValue: 120,
      entryPrice: 1.1,
      lowerPrice: 0.9,
      upperPrice: 1.3,
      openTime: "2025-06-02T12:00:00Z",
    });
    tracker.updateLiveEpoch({ currentPrice: 1.15, feesAccrued: 2 });
    const daily = tracker.snapshot(1.15, "2025-06-01").dailyPnl;
    assert.ok(daily.length >= 2, "should have at least 2 days");
    const rebDay = daily.find((d) => d.residual !== 0);
    assert.ok(rebDay, "should have a day with residual");
    // Cumulative with residuals should be larger than without
    const cumWithout = daily.reduce((s, d) => s + d.netPnl, 0);
    assert.ok(
      daily[0].cumulative > cumWithout,
      "cumulative with residuals should exceed sum of netPnl alone",
    );
  });

  it("large residual gap is reflected in cumulative", () => {
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 500,
      entryPrice: 1,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      openTime: "2025-07-01T00:00:00Z",
    });
    tracker.closeEpoch({
      exitValue: 480,
      gasCost: 1,
      token0UsdPrice: 0.95,
      token1UsdPrice: 1,
      closeTime: "2025-07-02T00:00:00Z",
    });
    // Large residual gap: 520 entry vs 480 exit = 40 residual
    tracker.openEpoch({
      entryValue: 520,
      entryPrice: 1.05,
      lowerPrice: 0.85,
      upperPrice: 1.25,
      openTime: "2025-07-03T00:00:00Z",
    });
    tracker.updateLiveEpoch({ currentPrice: 1.02, feesAccrued: 5 });
    const daily = tracker.snapshot(1.02, "2025-07-01").dailyPnl;
    const totalResidual = daily.reduce((s, d) => s + (d.residual || 0), 0);
    assert.ok(
      totalResidual > 0,
      "should have positive residual from epoch gap",
    );
  });
});
