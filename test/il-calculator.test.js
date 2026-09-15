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

  it("omits days with no activity entirely", () => {
    /*- Padding a blank row for every calendar day back to the pool's
     *  first mint would bury the figures: 55 active days across 172
     *  calendar is typical, so roughly fifteen pages of dashes around
     *  one page of data, and a row of dashes reads as missing data. */
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const closedEpoch = {
      closeTime: new Date(threeDaysAgo + "T10:00:00Z").getTime(),
      priceChangePnl: 10,
      feePnl: 5,
      fees: 5,
      gas: 1,
    };
    const result = _buildDailyPnl([closedEpoch], null);
    assert.strictEqual(result.length, 1, "no filler for the days between");
    assert.strictEqual(result[0].date, threeDaysAgo);
  });

  it("returns nothing at all when no day has activity", () => {
    assert.deepStrictEqual(_buildDailyPnl([], null), []);
  });

  it("keeps every active day, however far apart", () => {
    /*- Sparse history is the normal case on a long-lived position: the
     *  gaps are omitted, the active days all survive. */
    const day = (iso) => ({
      closeTime: new Date(iso).getTime(),
      priceChangePnl: 1,
      feePnl: 1,
      fees: 1,
      gas: 0,
    });
    const result = _buildDailyPnl(
      [
        day("2026-03-15T10:00:00Z"),
        day("2026-07-16T10:00:00Z"),
        day("2026-08-25T10:00:00Z"),
      ],
      null,
    );
    assert.deepStrictEqual(
      result.map((d) => d.date),
      ["2026-08-25", "2026-07-16", "2026-03-15"],
      "newest first, nothing in between",
    );
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

  it("puts the live epoch on today alongside older closed days", () => {
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const closedEpoch = {
      closeTime: twoDaysAgo.getTime(),
      priceChangePnl: 10,
      feePnl: 5,
      fees: 5,
      gas: 1,
    };
    const liveEpoch = {
      openTime: Date.now(),
      priceChangePnl: 0,
      feePnl: 2,
      fees: 2,
      gas: 0,
    };
    const result = _buildDailyPnl([closedEpoch], liveEpoch);
    assert.strictEqual(result.length, 2, "two active days, no filler");
    assert.strictEqual(result[0].date, today);
    assert.strictEqual(result[1].date, twoDaysAgo.toISOString().slice(0, 10));
    assert.strictEqual(result[1].feePnl, 5);
  });
});
