/**
 * @file test/lp-position-cache.test.js
 * @description Tests for the LP position cache module.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const path = require('path');
const {
  lpPositionCachePath,
  loadLpPositionCache,
  saveLpPositionCache,
  clearLpPositionCache,
  hasPositionActivitySince,
} = require('../src/lp-position-cache');

// ── Mock fs ─────────────────────────────────────────────────────────────────

function createMockFs() {
  const files = {};
  return {
    files,
    readFileSync(p) {
      if (files[p] === undefined) throw new Error('ENOENT');
      return files[p];
    },
    writeFileSync(p, data) {
      files[p] = data;
    },
    mkdirSync() {},
    unlinkSync(p) {
      if (files[p] === undefined) throw new Error('ENOENT');
      delete files[p];
    },
  };
}

const WALLET = '0x4e44847675763D5540B32Bee8a713CfDcb4bE61A';

// ── lpPositionCachePath ─────────────────────────────────────────────────────

describe('lp-position-cache — lpPositionCachePath', () => {
  it('builds path with blockchain + contract + wallet', () => {
    const result = lpPositionCachePath(WALLET, 'pulsechain', '0xCC05bf');
    assert.ok(path.basename(result).startsWith('lp-position-cache-pulse'));
    assert.ok(result.includes('tmp'));
  });

  it('is case-insensitive', () => {
    const a = lpPositionCachePath('0xABCDEF1234567890', 'pulsechain', '0xCC');
    const b = lpPositionCachePath('0xabcdef1234567890', 'pulsechain', '0xCC');
    assert.strictEqual(a, b);
  });
});

// ── save + load round-trip ──────────────────────────────────────────────────

describe('lp-position-cache — save/load', () => {
  let mockFs;
  beforeEach(() => { mockFs = createMockFs(); });

  it('round-trips positions and lastBlock', () => {
    const positions = [
      { tokenId: '100', token0: '0xAAA', fee: 3000 },
    ];
    saveLpPositionCache(WALLET, positions, 26100000, { fsModule: mockFs });
    const cached = loadLpPositionCache(WALLET, { fsModule: mockFs });
    assert.deepStrictEqual(cached.positions, positions);
    assert.strictEqual(cached.lastBlock, 26100000);
  });

  it('returns null when no cache exists', () => {
    assert.strictEqual(
      loadLpPositionCache(WALLET, { fsModule: mockFs }),
      null,
    );
  });

  it('returns null for corrupt cache', () => {
    const filePath = lpPositionCachePath(WALLET);
    mockFs.files[filePath] = 'NOT JSON';
    assert.strictEqual(
      loadLpPositionCache(WALLET, { fsModule: mockFs }),
      null,
    );
  });

  it('returns null when positions field is missing', () => {
    const filePath = lpPositionCachePath(WALLET);
    mockFs.files[filePath] = JSON.stringify({ lastBlock: 100 });
    assert.strictEqual(
      loadLpPositionCache(WALLET, { fsModule: mockFs }),
      null,
    );
  });

  it('returns null when lastBlock is missing', () => {
    const filePath = lpPositionCachePath(WALLET);
    mockFs.files[filePath] = JSON.stringify({ positions: [] });
    assert.strictEqual(
      loadLpPositionCache(WALLET, { fsModule: mockFs }),
      null,
    );
  });
});

// ── clearLpPositionCache ────────────────────────────────────────────────────

describe('lp-position-cache — clear', () => {
  it('removes the cache file', () => {
    const mockFs = createMockFs();
    saveLpPositionCache(WALLET, [{ tokenId: '1' }], 100, { fsModule: mockFs });
    assert.ok(loadLpPositionCache(WALLET, { fsModule: mockFs }));
    clearLpPositionCache(WALLET, { fsModule: mockFs });
    const after = loadLpPositionCache(WALLET, { fsModule: mockFs });
    assert.strictEqual(after, null);
  });

  it('does not throw when file does not exist', () => {
    const mockFs = createMockFs();
    assert.doesNotThrow(() =>
      clearLpPositionCache(WALLET, { fsModule: mockFs }),
    );
  });
});

// ── hasPositionActivitySince ────────────────────────────────────────────────

describe('lp-position-cache — hasPositionActivitySince', () => {
  function mockContract(
    transferOutHits, transferInHits,
    increaseHits, decreaseHits,
  ) {
    return {
      filters: {
        Transfer: () => 'transfer-filter',
        IncreaseLiquidity: () => 'increase-filter',
        DecreaseLiquidity: () => 'decrease-filter',
      },
      queryFilter: async (_filter, _from, _to) => {
        if (_filter === 'transfer-filter') {
          // Called twice: once for out, once for in
          const result = transferOutHits || transferInHits;
          if (transferOutHits) { transferOutHits = null; return result; }
          return transferInHits || [];
        }
        if (_filter === 'increase-filter') return increaseHits || [];
        if (_filter === 'decrease-filter') return decreaseHits || [];
        return [];
      },
    };
  }

  it('returns false when no events found', async () => {
    const contract = mockContract([], [], [], []);
    const result = await hasPositionActivitySince(
      contract, WALLET, ['100', '200'], 100, 200,
    );
    assert.strictEqual(result, false);
  });

  it('returns true when Transfer out events found', async () => {
    const contract = mockContract([{ fake: true }], [], [], []);
    const result = await hasPositionActivitySince(
      contract, WALLET, ['100'], 100, 200,
    );
    assert.strictEqual(result, true);
  });

  it('returns true when IncreaseLiquidity events found', async () => {
    const contract = mockContract([], [], [{ fake: true }], []);
    const result = await hasPositionActivitySince(
      contract, WALLET, ['100'], 100, 200,
    );
    assert.strictEqual(result, true);
  });

  it('returns true when DecreaseLiquidity events found', async () => {
    const contract = mockContract([], [], [], [{ fake: true }]);
    const result = await hasPositionActivitySince(
      contract, WALLET, ['100'], 100, 200,
    );
    assert.strictEqual(result, true);
  });

  it('returns false when fromBlock > toBlock', async () => {
    const contract = mockContract([{ fake: true }]);
    const result = await hasPositionActivitySince(
      contract, WALLET, ['100'], 200, 100,
    );
    assert.strictEqual(result, false);
  });

  it('works with empty tokenId list (Transfer only)', async () => {
    let callCount = 0;
    const contract = {
      filters: {
        Transfer: () => 'transfer-filter',
        IncreaseLiquidity: () => 'increase-filter',
        DecreaseLiquidity: () => 'decrease-filter',
      },
      queryFilter: async () => { callCount++; return []; },
    };
    const result = await hasPositionActivitySince(
      contract, WALLET, [], 100, 200,
    );
    assert.strictEqual(result, false);
    assert.strictEqual(callCount, 2, 'only Transfer queries, no liquidity queries');
  });
});
