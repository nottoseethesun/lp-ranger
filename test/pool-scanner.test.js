/**
 * @file test/pool-scanner.test.js
 * @description Tests for pool-scanner: appendToPoolCache, clearPoolCache.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TMP = path.join(process.cwd(), 'tmp');

describe('appendToPoolCache', () => {
  const pos = {
    token0: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39',
    token1: '0x57fde0a71132198BBeC939B98976993d8D89D225',
    fee: 2500,
  };
  const wallet = '0xABCDEF0000000000000000000000000000000001';
  let cachePath;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    const { eventCachePath } = require('../src/cache-store');
    cachePath = eventCachePath(
      pos, 'pulsechain',
      '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2',
      wallet);
    try { fs.unlinkSync(cachePath); } catch { /* */ }
  });

  after(() => {
    try { fs.unlinkSync(cachePath); } catch { /* */ }
  });

  it('creates cache with single event when empty', async () => {
    const { appendToPoolCache } = require('../src/pool-scanner');
    await appendToPoolCache(pos, wallet, {
      oldTokenId: '100', newTokenId: '200',
      txHashes: ['0xaaa', '0xbbb'],
      blockNumber: 5000,
    });
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const key = Object.keys(raw).find(
      (k) => k.startsWith('rebalance:'));
    assert.ok(key, 'cache key exists');
    const entry = raw[key].value;
    assert.equal(entry.events.length, 1);
    assert.equal(entry.events[0].oldTokenId, '100');
    assert.equal(entry.events[0].newTokenId, '200');
    assert.equal(entry.events[0].txHash, '0xbbb');
    assert.equal(entry.lastBlock, 5000);
  });

  it('appends to existing events', async () => {
    const { appendToPoolCache } = require('../src/pool-scanner');
    await appendToPoolCache(pos, wallet, {
      oldTokenId: '200', newTokenId: '300',
      txHashes: ['0xccc'],
      blockNumber: 6000,
    });
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const key = Object.keys(raw).find(
      (k) => k.startsWith('rebalance:'));
    const entry = raw[key].value;
    assert.equal(entry.events.length, 2);
    assert.equal(entry.events[1].newTokenId, '300');
    assert.equal(entry.events[0].index, 1);
    assert.equal(entry.events[1].index, 2);
    assert.equal(entry.lastBlock, 6000);
  });
});

describe('clearPoolCache', () => {
  it('clears the cache file', async () => {
    const { clearPoolCache } = require('../src/pool-scanner');
    const pos = {
      token0: '0x1111111111111111111111111111111111111111',
      token1: '0x2222222222222222222222222222222222222222',
      fee: 500,
    };
    const wallet = '0x3333333333333333333333333333333333333333';
    await clearPoolCache(pos, wallet);
  });
});
