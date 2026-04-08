/**
 * @file test/position-details-quick.test.js
 * @description Unit tests for pure helper functions in position-details-quick.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _currentPnl,
  _applyPriceOverrides,
  _baselineSummary,
} = require("../src/position-details-quick");

// ── _currentPnl ─────────────────────────────────────────────────────

describe("_currentPnl", () => {
  it("returns nulls when entryValue is 0", () => {
    const r = _currentPnl(null, 100, 0, 5, 1, 1);
    assert.strictEqual(r.priceGainLoss, null);
    assert.strictEqual(r.netPnl, null);
    assert.strictEqual(r.il, null);
    assert.strictEqual(r.profit, null);
  });

  it("computes priceGainLoss and netPnl when entryValue > 0", () => {
    const r = _currentPnl(null, 120, 100, 3, 1, 1);
    assert.strictEqual(r.priceGainLoss, 20);
    assert.strictEqual(r.netPnl, 23); // pgl + fees
    assert.strictEqual(r.il, null);
    assert.strictEqual(r.profit, null);
  });

  it("computes IL from baseline when provided", () => {
    const baseline = {
      hodlAmount0: 1000,
      hodlAmount1: 500,
    };
    const r = _currentPnl(baseline, 100, 110, 2, 0.05, 0.04);
    // hodlValue = 1000*0.05 + 500*0.04 = 50 + 20 = 70
    // il = lpValue - hodlValue = 100 - 70 = 30
    assert.strictEqual(r.il, 30);
    assert.strictEqual(r.priceGainLoss, -10);
    assert.strictEqual(r.netPnl, -8); // pgl + fees = -10 + 2
    assert.strictEqual(r.profit, 32); // fees + il = 2 + 30
  });

  it("computes profit as fees + il when il is 0", () => {
    const baseline = { hodlAmount0: 0, hodlAmount1: 0 };
    const r = _currentPnl(baseline, 200, 200, 10, 1, 1);
    // hodlValue = 0, il = 200 - 0 = 200
    assert.strictEqual(r.il, 200);
    assert.strictEqual(r.profit, 210); // fees + il = 10 + 200
  });

  it("handles negative price gain with fees", () => {
    const r = _currentPnl(null, 80, 100, 5, 1, 1);
    assert.strictEqual(r.priceGainLoss, -20);
    assert.strictEqual(r.netPnl, -15); // -20 + 5
  });
});

// ── _applyPriceOverrides ────────────────────────────────────────────

describe("_applyPriceOverrides", () => {
  it("applies override when fetched price is 0", () => {
    const prices = { price0: 0, price1: 0.5 };
    _applyPriceOverrides(prices, {
      priceOverride0: 1.5,
      priceOverride1: 0,
    });
    assert.strictEqual(prices.price0, 1.5);
    assert.strictEqual(prices.price1, 0.5); // override is 0 → skip
  });

  it("does not override non-zero fetched price without force", () => {
    const prices = { price0: 2, price1: 3 };
    _applyPriceOverrides(prices, {
      priceOverride0: 10,
      priceOverride1: 20,
    });
    assert.strictEqual(prices.price0, 2);
    assert.strictEqual(prices.price1, 3);
  });

  it("overrides non-zero fetched price with force", () => {
    const prices = { price0: 2, price1: 3 };
    _applyPriceOverrides(prices, {
      priceOverride0: 10,
      priceOverride1: 20,
      priceOverrideForce: true,
    });
    assert.strictEqual(prices.price0, 10);
    assert.strictEqual(prices.price1, 20);
  });

  it("skips override when override value is 0 even with force", () => {
    const prices = { price0: 2, price1: 3 };
    _applyPriceOverrides(prices, {
      priceOverride0: 0,
      priceOverride1: 0,
      priceOverrideForce: true,
    });
    assert.strictEqual(prices.price0, 2);
    assert.strictEqual(prices.price1, 3);
  });

  it("skips when body has no overrides", () => {
    const prices = { price0: 1, price1: 2 };
    _applyPriceOverrides(prices, {});
    assert.strictEqual(prices.price0, 1);
    assert.strictEqual(prices.price1, 2);
  });

  it("applies override for negative fetched price", () => {
    const prices = { price0: -1, price1: 0 };
    _applyPriceOverrides(prices, {
      priceOverride0: 5,
      priceOverride1: 6,
    });
    // -1 <= 0 so override applies
    assert.strictEqual(prices.price0, 5);
    assert.strictEqual(prices.price1, 6);
  });
});

// ── _baselineSummary ────────────────────────────────────────────────

describe("_baselineSummary", () => {
  it("returns null fields when baseline is null", () => {
    const r = _baselineSummary(null);
    assert.strictEqual(r.hodlBaseline, null);
    assert.strictEqual(r.baselineEntryValue, 0);
    assert.strictEqual(r.hodlBaselineNew, false);
    assert.strictEqual(r.hodlBaselineFallback, false);
    assert.strictEqual(r.mintDate, null);
    assert.strictEqual(r.mintTimestamp, null);
    assert.strictEqual(r.hodlAmount0, null);
    assert.strictEqual(r.hodlAmount1, null);
  });

  it("returns new baseline when entryValue is positive", () => {
    const bl = {
      entryValue: 500,
      hodlAmount0: 100,
      hodlAmount1: 200,
      mintDate: "2026-03-01",
      mintTimestamp: 1740787200000,
    };
    const r = _baselineSummary(bl);
    assert.strictEqual(r.hodlBaseline, bl);
    assert.strictEqual(r.baselineEntryValue, 500);
    assert.strictEqual(r.hodlBaselineNew, true);
    assert.strictEqual(r.hodlBaselineFallback, false);
    assert.strictEqual(r.mintDate, "2026-03-01");
    assert.strictEqual(r.mintTimestamp, 1740787200000);
    assert.strictEqual(r.hodlAmount0, 100);
    assert.strictEqual(r.hodlAmount1, 200);
  });

  it("returns fallback when no entryValue but has amounts", () => {
    const bl = {
      entryValue: 0,
      hodlAmount0: 100,
      hodlAmount1: 0,
    };
    const r = _baselineSummary(bl);
    assert.strictEqual(r.hodlBaselineNew, false);
    assert.strictEqual(r.hodlBaselineFallback, true);
  });

  it("returns neither new nor fallback when no entryValue and no amounts", () => {
    const bl = {
      entryValue: 0,
      hodlAmount0: 0,
      hodlAmount1: 0,
    };
    const r = _baselineSummary(bl);
    assert.strictEqual(r.hodlBaselineNew, false);
    assert.strictEqual(r.hodlBaselineFallback, false);
  });

  it("handles missing optional fields gracefully", () => {
    const bl = { entryValue: 10 };
    const r = _baselineSummary(bl);
    assert.strictEqual(r.mintDate, null);
    assert.strictEqual(r.mintTimestamp, null);
    assert.strictEqual(r.hodlAmount0, null);
    assert.strictEqual(r.hodlAmount1, null);
    assert.strictEqual(r.hodlBaselineNew, true);
  });
});
