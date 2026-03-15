'use strict';

/**
 * @file test/position-rangeW.test.js
 * @description Tests for per-position range width localStorage persistence.
 * Mirrors the logic in dashboard-helpers.js (posStorageKey, savePositionRangeW,
 * loadPositionRangeW) using a mock localStorage.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

// ── Mock localStorage ───────────────────────────────────────────────────────

function createMockStorage() {
  const store = {};
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    _store: store,
  };
}

// ── Replicate the helpers from dashboard-helpers.js ─────────────────────────

const POS_RANGE_PREFIX = '9mm_rangeW_';

function posStorageKey(pos) {
  if (!pos) return null;
  if (pos.positionType === 'nft' && pos.tokenId) return POS_RANGE_PREFIX + 'nft_' + pos.tokenId;
  if (pos.contractAddress) return POS_RANGE_PREFIX + 'erc20_' + pos.contractAddress.toLowerCase();
  return null;
}

function savePositionRangeW(storage, pos, rangeWPct) {
  const key = posStorageKey(pos);
  if (!key) return;
  try { storage.setItem(key, String(rangeWPct)); } catch (_) { /* private browsing */ }
}

function loadPositionRangeW(storage, pos, fallback) {
  const def = fallback !== undefined ? fallback : 20;
  const key = posStorageKey(pos);
  if (!key) return def;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return def;
    const n = parseFloat(raw);
    return (Number.isFinite(n) && n > 0) ? n : def;
  } catch (_) { return def; }
}

// ── posStorageKey ───────────────────────────────────────────────────────────

describe('posStorageKey', () => {
  it('returns null for null/undefined position', () => {
    assert.strictEqual(posStorageKey(null), null);
    assert.strictEqual(posStorageKey(undefined), null);
  });

  it('returns NFT key for NFT positions', () => {
    const pos = { positionType: 'nft', tokenId: '12345' };
    assert.strictEqual(posStorageKey(pos), '9mm_rangeW_nft_12345');
  });

  it('returns ERC-20 key for ERC-20 positions (lowercased)', () => {
    const pos = { positionType: 'erc20', contractAddress: '0xABCdef1234' };
    assert.strictEqual(posStorageKey(pos), '9mm_rangeW_erc20_0xabcdef1234');
  });

  it('returns null for NFT without tokenId', () => {
    const pos = { positionType: 'nft' };
    assert.strictEqual(posStorageKey(pos), null);
  });

  it('returns null for position without contractAddress or tokenId', () => {
    const pos = { positionType: 'other' };
    assert.strictEqual(posStorageKey(pos), null);
  });
});

// ── savePositionRangeW + loadPositionRangeW ─────────────────────────────────

describe('savePositionRangeW + loadPositionRangeW', () => {
  let storage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it('round-trip: save then load returns saved value', () => {
    const pos = { positionType: 'nft', tokenId: '42' };
    savePositionRangeW(storage, pos, 15);
    assert.strictEqual(loadPositionRangeW(storage, pos), 15);
  });

  it('returns default 20 when no value saved', () => {
    const pos = { positionType: 'nft', tokenId: '99' };
    assert.strictEqual(loadPositionRangeW(storage, pos), 20);
  });

  it('returns custom fallback when specified and no value saved', () => {
    const pos = { positionType: 'nft', tokenId: '99' };
    assert.strictEqual(loadPositionRangeW(storage, pos, 30), 30);
  });

  it('overwrites previous value', () => {
    const pos = { positionType: 'nft', tokenId: '42' };
    savePositionRangeW(storage, pos, 10);
    savePositionRangeW(storage, pos, 25);
    assert.strictEqual(loadPositionRangeW(storage, pos), 25);
  });

  it('stores different values per position', () => {
    const pos1 = { positionType: 'nft', tokenId: '1' };
    const pos2 = { positionType: 'nft', tokenId: '2' };
    savePositionRangeW(storage, pos1, 10);
    savePositionRangeW(storage, pos2, 30);
    assert.strictEqual(loadPositionRangeW(storage, pos1), 10);
    assert.strictEqual(loadPositionRangeW(storage, pos2), 30);
  });

  it('handles ERC-20 positions', () => {
    const pos = { positionType: 'erc20', contractAddress: '0xABC123' };
    savePositionRangeW(storage, pos, 12.5);
    assert.strictEqual(loadPositionRangeW(storage, pos), 12.5);
  });

  it('returns default for invalid stored value (NaN)', () => {
    const pos = { positionType: 'nft', tokenId: '42' };
    storage.setItem(posStorageKey(pos), 'not-a-number');
    assert.strictEqual(loadPositionRangeW(storage, pos), 20);
  });

  it('returns default for zero stored value', () => {
    const pos = { positionType: 'nft', tokenId: '42' };
    storage.setItem(posStorageKey(pos), '0');
    assert.strictEqual(loadPositionRangeW(storage, pos), 20);
  });

  it('returns default for negative stored value', () => {
    const pos = { positionType: 'nft', tokenId: '42' };
    storage.setItem(posStorageKey(pos), '-5');
    assert.strictEqual(loadPositionRangeW(storage, pos), 20);
  });

  it('silently returns default when position has no key', () => {
    const pos = { positionType: 'other' };
    savePositionRangeW(storage, pos, 15); // should do nothing
    assert.strictEqual(loadPositionRangeW(storage, pos), 20);
  });

  it('handles null position gracefully', () => {
    savePositionRangeW(storage, null, 15); // should not throw
    assert.strictEqual(loadPositionRangeW(storage, null), 20);
  });
});

// ── Startup behaviour ───────────────────────────────────────────────────────

describe('startup — range width restoration', () => {
  it('loads saved value for active position on startup', () => {
    const storage = createMockStorage();
    const pos = { positionType: 'nft', tokenId: '100' };
    savePositionRangeW(storage, pos, 35);

    // Simulate startup: load range width for the active position
    const rangeW = loadPositionRangeW(storage, pos);
    assert.strictEqual(rangeW, 35);
  });

  it('defaults to 20% when no saved value exists (fresh install)', () => {
    const storage = createMockStorage();
    const pos = { positionType: 'nft', tokenId: '100' };

    const rangeW = loadPositionRangeW(storage, pos);
    assert.strictEqual(rangeW, 20);
  });

  it('defaults to 20% when no active position exists', () => {
    const storage = createMockStorage();

    const rangeW = loadPositionRangeW(storage, null);
    assert.strictEqual(rangeW, 20);
  });
});
