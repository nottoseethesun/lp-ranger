/**
 * @file test/il-calculator.test.js
 * @description Unit tests for IL calculator functions (calcIlMultiplier, estimateLiveValue)
 * and the _buildDailyPnl pure utility.
 * Run with: npm test
 */

'use strict';
const { describe, it } = require('node:test');

const assert = require('assert');
const {
  calcIlMultiplier,
  estimateLiveValue,
  _buildDailyPnl,
} = require('../src/pnl-tracker');

// ── calcIlMultiplier ──────────────────────────────────────────────────────────

describe('calcIlMultiplier', () => {
  it('returns 0 for priceRatio === 1 (no price change)', () => {
    assert.strictEqual(calcIlMultiplier(1), 0);
  });

  it('returns negative value when price moves away from entry', () => {
    const il = calcIlMultiplier(2); // price doubled
    assert.ok(il < 0, 'IL should be negative (a loss)');
  });

  it('returns negative value when price drops', () => {
    const il = calcIlMultiplier(0.5);
    assert.ok(il < 0);
  });

  it('returns 0 for priceRatio <= 0 (guard against invalid input)', () => {
    assert.strictEqual(calcIlMultiplier(0), 0);
    assert.strictEqual(calcIlMultiplier(-1), 0);
  });

  it('is symmetric: doubling and halving produce equal magnitude IL', () => {
    const ilDouble = Math.abs(calcIlMultiplier(2));
    const ilHalf = Math.abs(calcIlMultiplier(0.5));
    assert.ok(Math.abs(ilDouble - ilHalf) < 1e-10);
  });
});

// ── estimateLiveValue ─────────────────────────────────────────────────────────

describe('estimateLiveValue', () => {
  it('returns entryValue when priceRatio === 1', () => {
    assert.strictEqual(estimateLiveValue(1000, 1), 1000);
  });

  it('returns less than entryValue when price moves significantly', () => {
    const val = estimateLiveValue(1000, 4); // 4× price move
    assert.ok(val < 1000, 'value should decrease with IL');
  });

  it('respects ilFactor parameter', () => {
    const v0 = estimateLiveValue(1000, 2, 0); // 0% sensitivity → no IL
    const v1 = estimateLiveValue(1000, 2, 1); // 100% sensitivity
    assert.ok(v0 > v1, 'higher ilFactor should lower value more');
  });
});

// ── _buildDailyPnl ──────────────────────────────────────────────────────────

describe('_buildDailyPnl', () => {
  it('returns empty array when no epochs', () => {
    assert.deepStrictEqual(_buildDailyPnl([], null), []);
  });

  it('distributes live epoch P&L evenly across days since openTime', () => {
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const openDay = twoDaysAgo.toISOString().slice(0, 10);
    const liveEpoch = {
      openTime: twoDaysAgo.getTime(),
      priceChangePnl: -6,
      feePnl: 3,
      fees: 3,
      gas: 0.3,
    };
    const result = _buildDailyPnl([], liveEpoch);
    assert.strictEqual(result.length, 3, 'should have 3 days');
    assert.strictEqual(result[0].date, today, 'newest first');
    assert.strictEqual(
      result[result.length - 1].date,
      openDay,
      'oldest last',
    );
    // Each day gets 1/3 of fees (1.0), price (-2.0), gas (0.1)
    const totalFees = result.reduce((s, d) => s + d.feePnl, 0);
    const totalPrice = result.reduce((s, d) => s + d.priceChangePnl, 0);
    assert.ok(
      Math.abs(totalFees - 3) < 0.01,
      'total fees should sum to 3',
    );
    assert.ok(
      Math.abs(totalPrice - -6) < 0.01,
      'total price P&L should sum to -6',
    );
  });

  it('fills zero-value days from fromDate to today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const result = _buildDailyPnl([], null, threeDaysAgo);
    // Should have 4 days: threeDaysAgo, twoDaysAgo, yesterday, today
    assert.strictEqual(result.length, 4);
    assert.strictEqual(result[0].date, today);
    assert.strictEqual(result[result.length - 1].date, threeDaysAgo);
    // All zero
    result.forEach((d) => {
      assert.strictEqual(d.netPnl, 0);
      assert.strictEqual(d.cumulative, 0);
    });
  });

  it('fromDate creates zero rows without affecting fee distribution', () => {
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
    assert.ok(
      Math.abs(totalFees - 10) < 0.01,
      'total fees should sum to 10',
    );
    // Only today should have fees (positionStartDate is undefined → epochDay)
    assert.ok(result[0].feePnl > 9.9, 'today should have all fees');
  });

  it('positionStartDate distributes live fees from mint date, not fromDate', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const liveEpoch = {
      openTime: Date.now(),
      priceChangePnl: 0,
      feePnl: 12,
      fees: 12,
      gas: 0,
    };
    const result = _buildDailyPnl([], liveEpoch, fiveDaysAgo, twoDaysAgo);
    assert.strictEqual(
      result.length,
      6,
      `expected 6 days, got ${result.length}`,
    );
    const totalFees = result.reduce((s, d) => s + d.feePnl, 0);
    assert.ok(
      Math.abs(totalFees - 12) < 0.01,
      'total fees should sum to 12',
    );
    const earlyDays = result.filter((d) => d.date < twoDaysAgo);
    for (const d of earlyDays) {
      assert.strictEqual(d.feePnl, 0, `day ${d.date} should have $0 fees`);
    }
    const dailyFee = 12 / 3;
    const activeDays = result.filter((d) => d.date >= twoDaysAgo);
    assert.strictEqual(activeDays.length, 3);
    for (const d of activeDays) {
      assert.ok(
        Math.abs(d.feePnl - dailyFee) < 0.01,
        `day ${d.date} feePnl=${d.feePnl}, expected ~${dailyFee}`,
      );
    }
  });

  it('distributes closed epoch fees across open→close duration', () => {
    const day1 = new Date('2025-06-01T10:00:00Z').getTime();
    const day3 = new Date('2025-06-03T14:00:00Z').getTime();
    const closedEpoch = {
      openTime: day1,
      closeTime: day3,
      priceChangePnl: -6,
      feePnl: 3,
      fees: 3,
      gas: 0.3,
    };
    const result = _buildDailyPnl([closedEpoch], null);
    assert.strictEqual(result.length, 3, 'should have 3 days');
    assert.strictEqual(result[0].date, '2025-06-03', 'newest first');
    assert.strictEqual(result[2].date, '2025-06-01', 'oldest last');
    const totalFees = result.reduce((s, d) => s + d.feePnl, 0);
    assert.ok(
      Math.abs(totalFees - 3) < 0.01,
      'total fees should sum to 3',
    );
    // Each day gets 1/3
    for (const d of result) {
      assert.ok(
        Math.abs(d.feePnl - 1) < 0.01,
        `day ${d.date} should have ~$1 fee`,
      );
    }
  });

  it('merges fromDate fill with epoch data', () => {
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
