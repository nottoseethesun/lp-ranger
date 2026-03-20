/**
 * @file test/epoch-reconstructor.test.js
 * @description Unit tests for the epoch-reconstructor module.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { _buildClosedEpoch } = require('../src/epoch-reconstructor');

describe('_buildClosedEpoch', () => {
  it('returns null when no dates available', () => {
    assert.strictEqual(_buildClosedEpoch({ mintDate: null, closeDate: null }, 0), null);
  });

  it('builds epoch from position history data', () => {
    const h = {
      mintDate: '2026-03-15T10:00:00Z', closeDate: '2026-03-17T14:00:00Z',
      entryValueUsd: 300, exitValueUsd: 295, feesEarnedUsd: 0.50,
      token0UsdPriceAtOpen: 0.0016, token1UsdPriceAtOpen: 0.0006,
      token0UsdPriceAtClose: 0.0017, token1UsdPriceAtClose: 0.00059,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.strictEqual(ep.status, 'closed');
    assert.strictEqual(ep.entryValue, 300);
    assert.strictEqual(ep.exitValue, 295);
    assert.strictEqual(ep.fees, 0.50);
    assert.strictEqual(ep.feePnl, 0.50);
    assert.strictEqual(ep.priceChangePnl, 295 - 300 - 0.50);
    assert.strictEqual(ep.openTime, new Date('2026-03-15T10:00:00Z').getTime());
    assert.strictEqual(ep.closeTime, new Date('2026-03-17T14:00:00Z').getTime());
    assert.strictEqual(ep.id, 1);
    assert.strictEqual(ep.color, '#00e5ff');
  });

  it('uses openTime as closeTime fallback when closeDate is null', () => {
    const h = {
      mintDate: '2026-03-15T10:00:00Z', closeDate: null,
      entryValueUsd: 100, exitValueUsd: 0, feesEarnedUsd: 0,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.ok(ep);
    assert.strictEqual(ep.closeTime, ep.openTime);
  });

  it('handles missing USD values gracefully', () => {
    const h = {
      mintDate: '2026-03-15T10:00:00Z', closeDate: '2026-03-16T10:00:00Z',
      entryValueUsd: null, exitValueUsd: null, feesEarnedUsd: null,
    };
    const ep = _buildClosedEpoch(h, 2);
    assert.ok(ep);
    assert.strictEqual(ep.entryValue, 0);
    assert.strictEqual(ep.exitValue, 0);
    assert.strictEqual(ep.fees, 0);
    assert.strictEqual(ep.id, 3);
  });

  it('assigns correct colour per index', () => {
    const h = { mintDate: '2026-01-01T00:00:00Z', closeDate: '2026-01-02T00:00:00Z',
      entryValueUsd: 100, exitValueUsd: 100, feesEarnedUsd: 1 };
    assert.strictEqual(_buildClosedEpoch(h, 0).color, '#00e5ff');
    assert.strictEqual(_buildClosedEpoch(h, 1).color, '#ff6b35');
    assert.strictEqual(_buildClosedEpoch(h, 10).color, '#00e5ff'); // wraps
  });

  it('computes epochPnl correctly', () => {
    const h = { mintDate: '2026-01-01T00:00:00Z', closeDate: '2026-01-02T00:00:00Z',
      entryValueUsd: 200, exitValueUsd: 190, feesEarnedUsd: 3 };
    const ep = _buildClosedEpoch(h, 0);
    // epochPnl = (exit - entry) + fees = (190 - 200) + 3 = -7
    assert.strictEqual(ep.epochPnl, -7);
    // priceChangePnl = exit - entry - fees = 190 - 200 - 3 = -13
    assert.strictEqual(ep.priceChangePnl, -13);
  });
});
