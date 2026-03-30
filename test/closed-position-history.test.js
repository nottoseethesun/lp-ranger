/**
 * @file test/closed-position-history.test.js
 * @description Tests for the GET /api/position/:tokenId/history endpoint.
 * Exercises the getPositionHistory() helper directly with known rebalance_log.json data.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { getPositionHistory } = require('../src/position-history');

const TMP = path.join(process.cwd(), 'tmp');
const LOG_PATH = path.join(TMP, 'test-rebalance-log.json');

describe('getPositionHistory', () => {
  let origLogFile = null;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    origLogFile = config.LOG_FILE;
    config.LOG_FILE = 'tmp/test-rebalance-log.json';

    const testEntries = [
      {
        oldTokenId: '100',
        newTokenId: '200',
        loggedAt: '2026-01-15T10:00:00Z',
        entryValueUsd: 1000,
        exitValueUsd: 1050,
        token0UsdPrice: 0.5,
        token1UsdPrice: 1.0,
        feesEarnedUsd: 25,
        gasCostWei: '500000',
      },
      {
        oldTokenId: '200',
        newTokenId: '300',
        loggedAt: '2026-02-20T14:30:00Z',
        entryValueUsd: 1050,
        exitValueUsd: 1100,
        token0UsdPrice: 0.55,
        token1UsdPrice: 1.1,
        feesEarnedUsd: 30,
        gasCostWei: '600000',
      },
    ];
    fs.writeFileSync(LOG_PATH, JSON.stringify(testEntries), 'utf8');
  });

  after(() => {
    try { fs.unlinkSync(LOG_PATH); } catch { /* */ }
    if (origLogFile !== null) config.LOG_FILE = origLogFile;
  });

  it('returns mint and close data for a mid-chain tokenId (200)', async () => {
    const body = await getPositionHistory('200', {});
    assert.strictEqual(body.tokenId, '200');
    assert.strictEqual(body.entryValueUsd, 1000);
    assert.strictEqual(body.mintDate, '2026-01-15T10:00:00Z');
    assert.strictEqual(body.token0UsdPriceAtOpen, 0.5);
    assert.strictEqual(body.exitValueUsd, 1100);
    assert.strictEqual(body.closeDate, '2026-02-20T14:30:00Z');
    assert.strictEqual(body.feesEarnedUsd, 30);
  });

  it('returns mint data only for the latest tokenId (300)', async () => {
    const body = await getPositionHistory('300', {});
    assert.strictEqual(body.entryValueUsd, 1050);
    assert.strictEqual(body.mintDate, '2026-02-20T14:30:00Z');
    assert.strictEqual(body.exitValueUsd, null);
    assert.strictEqual(body.closeDate, null);
  });

  it('returns close data only for the first tokenId (100)', async () => {
    const body = await getPositionHistory('100', {});
    assert.strictEqual(body.entryValueUsd, null);
    assert.strictEqual(body.exitValueUsd, 1050);
    assert.strictEqual(body.closeDate, '2026-01-15T10:00:00Z');
  });

  it('returns nulls for USD values when tokenId has no log entry', async () => {
    const body = await getPositionHistory('99999', {});
    assert.strictEqual(body.tokenId, '99999');
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    assert.strictEqual(body.exitValueUsd, null);
  });

  it('supplements timestamps and txHash from rebalanceEvents', async () => {
    fs.writeFileSync(
      LOG_PATH,
      JSON.stringify([{ oldTokenId: '400', newTokenId: '500' }]),
      'utf8',
    );
    const events = [
      {
        oldTokenId: '400',
        newTokenId: '500',
        timestamp: 1700000000,
        txHash: '0xabc123',
      },
    ];

    const body = await getPositionHistory('500', {
      rebalanceEvents: events,
    });
    assert.ok(
      body.mintDate,
      'mintDate should be populated from rebalanceEvents',
    );
    assert.ok(body.mintDate.includes('2023'));
    assert.strictEqual(body.mintTxHash, '0xabc123');

    const body2 = await getPositionHistory('400', {
      rebalanceEvents: events,
    });
    assert.ok(body2.closeDate);
    assert.strictEqual(body2.closeTxHash, '0xabc123');
  });

  it('returns dates from events even with no rebalance log file', async () => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* already gone */
    }
    const events = [
      {
        oldTokenId: '600',
        newTokenId: '700',
        timestamp: 1700000000,
        txHash: '0xdef456',
      },
    ];

    const body = await getPositionHistory('700', {
      rebalanceEvents: events,
    });
    assert.strictEqual(body.tokenId, '700');
    assert.ok(body.mintDate);
    assert.strictEqual(body.mintTxHash, '0xdef456');
    assert.strictEqual(body.entryValueUsd, null);

    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  });

  it('handles missing log file gracefully', async () => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* already gone */
    }
    const body = await getPositionHistory('200', {});
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  });
});
