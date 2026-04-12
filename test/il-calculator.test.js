/**
 * @file test/il-calculator.test.js
 * @description Unit tests for IL calculator functions (calcIlMultiplier, estimateLiveValue)
 * and the _buildDailyPnl pure utility.
 * Run with: npm test
 */

"use strict";
const { describe, it } = require("node:test");

const assert = require("assert");
const {
  calcIlMultiplier,
  estimateLiveValue,
  _buildDailyPnl,
} = require("../src/pnl-tracker");

// ── calcIlMultiplier ──────────────────────────────────────────────────────────

describe("calcIlMultiplier", () => {
  it("returns 0 for priceRatio === 1 (no price change)", () => {
    assert.strictEqual(calcIlMultiplier(1), 0);
  });

  it("returns negative value when price moves away from entry", () => {
    const il = calcIlMultiplier(2); // price doubled
    assert.ok(il < 0, "IL should be negative (a loss)");
  });

  it("returns negative value when price drops", () => {
    const il = calcIlMultiplier(0.5);
    assert.ok(il < 0);
  });

  it("returns 0 for priceRatio <= 0 (guard against invalid input)", () => {
    assert.strictEqual(calcIlMultiplier(0), 0);
    assert.strictEqual(calcIlMultiplier(-1), 0);
  });

  it("is symmetric: doubling and halving produce equal magnitude IL", () => {
    const ilDouble = Math.abs(calcIlMultiplier(2));
    const ilHalf = Math.abs(calcIlMultiplier(0.5));
    assert.ok(Math.abs(ilDouble - ilHalf) < 1e-10);
  });
});

// ── estimateLiveValue ─────────────────────────────────────────────────────────

describe("estimateLiveValue", () => {
  it("returns entryValue when priceRatio === 1", () => {
    assert.strictEqual(estimateLiveValue(1000, 1), 1000);
  });

  it("returns less than entryValue when price moves significantly", () => {
    const val = estimateLiveValue(1000, 4); // 4× price move
    assert.ok(val < 1000, "value should decrease with IL");
  });

  it("respects ilFactor parameter", () => {
    const v0 = estimateLiveValue(1000, 2, 0); // 0% sensitivity → no IL
    const v1 = estimateLiveValue(1000, 2, 1); // 100% sensitivity
    assert.ok(v0 > v1, "higher ilFactor should lower value more");
  });
});

// ── _buildDailyPnl ──────────────────────────────────────────────────────────

describe("_buildDailyPnl", () => {
  it("returns empty array when no epochs", () => {
    assert.deepStrictEqual(_buildDailyPnl([], null), []);
  });

  it("attributes live epoch P&L to today only, older days show noData", () => {
    const today = new Date().toISOString().slice(0, 10);
    const liveEpoch = {
      openTime: Date.now() - 2 * 86_400_000,
      priceChangePnl: -6,
      feePnl: 3,
      fees: 3,
      gas: 0.3,
    };
    const result = _buildDailyPnl([], liveEpoch);
    assert.strictEqual(
      result.length,
      1,
      "only today (no filler without fromDate)",
    );
    assert.strictEqual(result[0].date, today);
    assert.ok(Math.abs(result[0].feePnl - 3) < 0.01, "all fees on today");
    assert.strictEqual(result[0].noData, false, "today has real data");
  });

  it("fills noData days from fromDate to today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const result = _buildDailyPnl([], null, threeDaysAgo);
    assert.strictEqual(result.length, 4);
    assert.strictEqual(result[0].date, today);
    assert.strictEqual(result[result.length - 1].date, threeDaysAgo);
    result.forEach((d) => {
      assert.strictEqual(d.noData, true, `${d.date} should be noData`);
      assert.strictEqual(d.netPnl, 0);
    });
  });

  it("fromDate creates zero rows without affecting fee distribution", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const liveEpoch = {
      openTime: Date.now(),
      priceChangePnl: 0,
      feePnl: 10,
      fees: 10,
      gas: 0,
    };
    // fromDate creates 6 rows, but fees land only on today (epochDay)
    const result = _buildDailyPnl([], liveEpoch, fiveDaysAgo, undefined);
    assert.strictEqual(
      result.length,
      6,
      `expected 6 days, got ${result.length}`,
    );
    const totalFees = result.reduce((s, d) => s + d.feePnl, 0);
    assert.ok(Math.abs(totalFees - 10) < 0.01, "total fees should sum to 10");
    // Only today should have fees (positionStartDate is undefined → epochDay)
    assert.ok(result[0].feePnl > 9.9, "today should have all fees");
  });

  it("live epoch with fromDate fills zeros + today row", () => {
    const today = new Date().toISOString().slice(0, 10);
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const liveEpoch = {
      openTime: Date.now(),
      priceChangePnl: 0,
      feePnl: 12,
      fees: 12,
      gas: 0,
    };
    const result = _buildDailyPnl([], liveEpoch, fiveDaysAgo);
    assert.strictEqual(result.length, 6, "6 days filled");
    const todayRow = result.find((d) => d.date === today);
    assert.ok(todayRow, "today row exists");
    assert.ok(Math.abs(todayRow.feePnl - 12) < 0.01, "all fees on today");
    const otherDays = result.filter((d) => d.date !== today);
    for (const d of otherDays)
      assert.strictEqual(d.feePnl, 0, `${d.date} should have $0 fees`);
  });

  it("attributes closed epoch totals to close day only", () => {
    const day1 = new Date("2025-06-01T10:00:00Z").getTime();
    const day3 = new Date("2025-06-03T14:00:00Z").getTime();
    const closedEpoch = {
      openTime: day1,
      closeTime: day3,
      priceChangePnl: -6,
      feePnl: 3,
      fees: 3,
      gas: 0.3,
    };
    const result = _buildDailyPnl([closedEpoch], null);
    assert.strictEqual(result.length, 1, "only close day");
    assert.strictEqual(result[0].date, "2025-06-03");
    assert.ok(Math.abs(result[0].feePnl - 3) < 0.01, "all fees on close day");
    assert.strictEqual(result[0].noData, false);
  });

  it("merges fromDate fill with epoch data", () => {
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const fromDate = twoDaysAgo.toISOString().slice(0, 10);
    const closedEpoch = {
      closeTime: twoDaysAgo.getTime(),
      priceChangePnl: 10,
      feePnl: 5,
      fees: 5,
      gas: 1,
    };
    const result = _buildDailyPnl([closedEpoch], null, fromDate);
    assert.strictEqual(result.length, 3); // twoDaysAgo, yesterday, today
    // Oldest day (twoDaysAgo) has the epoch data
    const oldest = result[result.length - 1];
    assert.strictEqual(oldest.date, fromDate);
    assert.strictEqual(oldest.feePnl, 5);
    // Today has zeros
    assert.strictEqual(result[0].date, today);
    assert.strictEqual(result[0].netPnl, 0);
  });
});
