/**
 * @file test/closed-position-history.test.js
 * @description Tests for the GET /api/position/:tokenId/history endpoint.
 * Exercises the _getPositionHistory() helper with known rebalance_log.json data.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { start, stop, botState } = require('../server');

const TEST_PORT = 54380;
const LOG_PATH  = path.join(process.cwd(), 'rebalance_log.json');

/** Make a simple HTTP GET request. */
function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: TEST_PORT, path: urlPath }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    }).on('error', reject);
  });
}

describe('GET /api/position/:tokenId/history', () => {
  let origLog = null;
  let origEvents = undefined;

  before(async () => {
    // Save original log file if it exists
    try { origLog = fs.readFileSync(LOG_PATH, 'utf8'); } catch { origLog = null; }
    origEvents = botState.rebalanceEvents;

    // Write a test log file
    const testEntries = [
      {
        oldTokenId: '100', newTokenId: '200',
        loggedAt: '2026-01-15T10:00:00Z',
        entryValueUsd: 1000, exitValueUsd: 1050,
        token0UsdPrice: 0.5, token1UsdPrice: 1.0,
        feesEarnedUsd: 25, gasCostWei: '500000',
      },
      {
        oldTokenId: '200', newTokenId: '300',
        loggedAt: '2026-02-20T14:30:00Z',
        entryValueUsd: 1050, exitValueUsd: 1100,
        token0UsdPrice: 0.55, token1UsdPrice: 1.1,
        feesEarnedUsd: 30, gasCostWei: '600000',
      },
    ];
    fs.writeFileSync(LOG_PATH, JSON.stringify(testEntries), 'utf8');
    await start(TEST_PORT);
  });

  after(async () => {
    await stop();
    // Restore original log file
    if (origLog !== null) fs.writeFileSync(LOG_PATH, origLog, 'utf8');
    else { try { fs.unlinkSync(LOG_PATH); } catch { /* no file */ } }
    botState.rebalanceEvents = origEvents;
  });

  it('returns mint and close data for a mid-chain tokenId (200)', async () => {
    const { status, body } = await get('/api/position/200/history');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.tokenId, '200');
    // 200 was minted in the first entry (newTokenId=200)
    assert.strictEqual(body.entryValueUsd, 1000);
    assert.strictEqual(body.mintDate, '2026-01-15T10:00:00Z');
    assert.strictEqual(body.token0UsdPriceAtOpen, 0.5);
    // 200 was closed in the second entry (oldTokenId=200)
    assert.strictEqual(body.exitValueUsd, 1100);
    assert.strictEqual(body.closeDate, '2026-02-20T14:30:00Z');
    assert.strictEqual(body.feesEarnedUsd, 30);
  });

  it('returns mint data only for the latest tokenId (300)', async () => {
    const { status, body } = await get('/api/position/300/history');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.entryValueUsd, 1050);
    assert.strictEqual(body.mintDate, '2026-02-20T14:30:00Z');
    // 300 was never closed
    assert.strictEqual(body.exitValueUsd, null);
    assert.strictEqual(body.closeDate, null);
  });

  it('returns close data only for the first tokenId (100)', async () => {
    const { status, body } = await get('/api/position/100/history');
    assert.strictEqual(status, 200);
    // 100 was never minted in the log (it was the original)
    assert.strictEqual(body.entryValueUsd, null);
    // mintDate may be populated from on-chain Transfer lookup (tokenId 100 exists on PulseChain)
    // 100 was closed in the first entry
    assert.strictEqual(body.exitValueUsd, 1050);
    assert.strictEqual(body.closeDate, '2026-01-15T10:00:00Z');
  });

  it('returns nulls for USD values when tokenId has no log entry', async () => {
    const { status, body } = await get('/api/position/99999/history');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.tokenId, '99999');
    // mintDate may be populated from on-chain Transfer lookup
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    assert.strictEqual(body.exitValueUsd, null);
  });

  it('supplements timestamps and txHash from botState.rebalanceEvents', async () => {
    // Remove the log file to clear log-based timestamps
    fs.writeFileSync(LOG_PATH, JSON.stringify([
      { oldTokenId: '400', newTokenId: '500' },
    ]), 'utf8');
    botState.rebalanceEvents = [
      { oldTokenId: '400', newTokenId: '500', timestamp: 1700000000, txHash: '0xabc123' },
    ];

    const { body } = await get('/api/position/500/history');
    // mintDate should come from rebalanceEvents timestamp
    assert.ok(body.mintDate, 'mintDate should be populated from rebalanceEvents');
    assert.ok(body.mintDate.includes('2023'), 'should be a 2023 date from timestamp 1700000000');
    assert.strictEqual(body.mintTxHash, '0xabc123');

    const { body: body2 } = await get('/api/position/400/history');
    assert.ok(body2.closeDate, 'closeDate should be populated from rebalanceEvents');
    assert.strictEqual(body2.closeTxHash, '0xabc123');

    botState.rebalanceEvents = origEvents;
  });

  it('returns dates from events even with no rebalance log file', async () => {
    try { fs.unlinkSync(LOG_PATH); } catch { /* already gone */ }
    botState.rebalanceEvents = [
      { oldTokenId: '600', newTokenId: '700', timestamp: 1700000000, txHash: '0xdef456' },
    ];

    const { body } = await get('/api/position/700/history');
    assert.strictEqual(body.tokenId, '700');
    assert.ok(body.mintDate, 'mintDate should come from events even without log file');
    assert.strictEqual(body.mintTxHash, '0xdef456');
    assert.strictEqual(body.entryValueUsd, null, 'USD values remain null');

    botState.rebalanceEvents = origEvents;
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  });

  it('handles missing log file gracefully', async () => {
    try { fs.unlinkSync(LOG_PATH); } catch { /* already gone */ }
    const { status, body } = await get('/api/position/200/history');
    assert.strictEqual(status, 200);
    // mintDate may be populated from on-chain Transfer lookup (tokenId 200 exists on PulseChain)
    // closeDate and USD values should remain null without log or events
    assert.strictEqual(body.closeDate, null);
    assert.strictEqual(body.entryValueUsd, null);
    // Restore for other tests
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  });
});
