/**
 * @file test/position-store.test.js
 * @description Unit tests for the position-store module.
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  createPositionStore,
  formatPositionLabel,
  formatPositionSummary,
  validateEntry,
  MAX_POSITIONS,
  DEFAULT_PAGE_SIZE,
} = require('../src/position-store');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NFT_BASE = {
  positionType:  'nft',
  tokenId:       '12847',
  walletAddress: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
  walletSource:  'seed',
  token0:        'WPLS',
  token1:        'USDC',
  fee:           3000,
  tickLower:     -207240,
  tickUpper:     -204720,
  liquidity:     124839201n,
};

const ERC_BASE = {
  positionType:    'erc20',
  contractAddress: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
  walletAddress:   '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc',
  walletSource:    'key',
  token0:          'WPLS',
  token1:          'DAI',
  fee:             500,
  tickLower:       -100,
  tickUpper:       100,
  liquidity:       5000n,
};

/** Build a unique NFT entry with a given token ID. */
function makeNft(tokenId, walletAddress = NFT_BASE.walletAddress) {
  return { ...NFT_BASE, tokenId: String(tokenId), walletAddress };
}

// ── validateEntry ─────────────────────────────────────────────────────────────

describe('validateEntry', () => {
  it('accepts a valid NFT entry', () => {
    const r = validateEntry(NFT_BASE);
    assert.strictEqual(r.valid, true);
  });

  it('accepts a valid ERC-20 entry', () => {
    const r = validateEntry(ERC_BASE);
    assert.strictEqual(r.valid, true);
  });

  it('rejects null input', () => {
    const r = validateEntry(null);
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.length > 0);
  });

  it('rejects missing walletAddress', () => {
    const r = validateEntry({ ...NFT_BASE, walletAddress: '' });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /walletAddress/i);
  });

  it('rejects invalid positionType', () => {
    const r = validateEntry({ ...NFT_BASE, positionType: 'lp' });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /positionType/i);
  });

  it('rejects nft entry missing tokenId', () => {
    const { tokenId: _t, ...noId } = NFT_BASE;
    const r = validateEntry({ ...noId, positionType: 'nft' });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /tokenId/i);
  });

  it('rejects erc20 entry missing contractAddress', () => {
    const { contractAddress: _c, ...noAddr } = ERC_BASE;
    const r = validateEntry({ ...noAddr, positionType: 'erc20' });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /contractAddress/i);
  });

  it('accepts positionType unknown without id fields', () => {
    const r = validateEntry({ positionType: 'unknown', walletAddress: '0xABC' });
    assert.strictEqual(r.valid, true);
  });
});

// ── add ───────────────────────────────────────────────────────────────────────

describe('createPositionStore — add', () => {
  it('adds a valid NFT position', () => {
    const store  = createPositionStore();
    const result = store.add(NFT_BASE);
    assert.strictEqual(result.ok, true);
    assert.ok(result.entry !== undefined);
    assert.strictEqual(result.entry.tokenId, '12847');
    assert.strictEqual(store.count(), 1);
  });

  it('adds a valid ERC-20 position', () => {
    const store  = createPositionStore();
    const result = store.add(ERC_BASE);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(store.count(), 1);
  });

  it('auto-selects the first position added', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const active = store.getActive();
    assert.ok(active !== null);
    assert.strictEqual(active.tokenId, '12847');
  });

  it('rejects a duplicate NFT (same wallet + tokenId)', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.add({ ...NFT_BASE });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /already exists/i);
  });

  it('allows same tokenId for a different wallet', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.add({ ...NFT_BASE, walletAddress: '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store.count(), 2);
  });

  it('rejects invalid entry (returns error, does not throw)', () => {
    const store = createPositionStore();
    const r     = store.add({ positionType: 'nft', walletAddress: '' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
    assert.strictEqual(store.count(), 0);
  });

  it('coerces tokenId to string', () => {
    const store = createPositionStore();
    store.add({ ...NFT_BASE, tokenId: 99999 });
    assert.strictEqual(store.getActive().tokenId, '99999');
  });

  it('coerces liquidity to BigInt', () => {
    const store = createPositionStore();
    store.add({ ...NFT_BASE, liquidity: '500000' });
    assert.strictEqual(typeof store.getActive().liquidity, 'bigint');
    assert.strictEqual(store.getActive().liquidity, 500000n);
  });

  it('assigns correct 0-based index', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    assert.strictEqual(store.toArray()[0].index, 0);
    assert.strictEqual(store.toArray()[1].index, 1);
  });

  it('stores addedAt timestamp', () => {
    const clock  = { now: 1_700_000_000_000 };
    const store  = createPositionStore({ nowFn: () => clock.now });
    store.add(NFT_BASE);
    assert.strictEqual(store.getActive().addedAt, 1_700_000_000_000);
  });
});

// ── capacity limit ────────────────────────────────────────────────────────────

describe('createPositionStore — capacity', () => {
  it('isFull returns false when below limit', () => {
    const store = createPositionStore();
    assert.strictEqual(store.isFull(), false);
  });

  it('isFull returns true at MAX_POSITIONS', () => {
    const store = createPositionStore();
    for (let i = 0; i < MAX_POSITIONS; i++) {
      store.add(makeNft(i + 10000, `0x${String(i).padStart(40, '0')}`));
    }
    assert.strictEqual(store.isFull(), true);
  });

  it('add returns error when store is full', () => {
    const store = createPositionStore();
    for (let i = 0; i < MAX_POSITIONS; i++) {
      store.add(makeNft(i + 10000, `0x${String(i).padStart(40, '0')}`));
    }
    const r = store.add(makeNft(99999, '0x' + 'f'.repeat(40)));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /full/i);
  });

  it('MAX_POSITIONS is 300', () => {
    assert.strictEqual(MAX_POSITIONS, 300);
  });
});

// ── select ────────────────────────────────────────────────────────────────────

describe('createPositionStore — select', () => {
  it('selects a valid index', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    const r = store.select(1);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store.getActive().tokenId, '2');
  });

  it('deactivates the previously active entry', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    store.select(1);
    const all = store.toArray();
    assert.strictEqual(all[0].active, false);
    assert.strictEqual(all[1].active, true);
  });

  it('returns error for out-of-bounds index', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.select(5);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /out of range/i);
  });

  it('returns error for negative index', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.select(-1);
    assert.strictEqual(r.ok, false);
  });
});

// ── remove ────────────────────────────────────────────────────────────────────

describe('createPositionStore — remove', () => {
  it('removes an entry and re-indexes', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    store.add(makeNft('3', '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe'));
    store.remove(1); // remove middle
    const all = store.toArray();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].index, 0);
    assert.strictEqual(all[1].index, 1);
    assert.strictEqual(all[1].tokenId, '3');
  });

  it('selects previous entry when active entry is removed', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    store.select(1);
    store.remove(1);
    assert.strictEqual(store.getActive().tokenId, '1');
  });

  it('sets activeIndex to -1 when last entry is removed', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    store.remove(0);
    assert.strictEqual(store.getActive(), null);
    assert.strictEqual(store.count(), 0);
  });

  it('returns error for out-of-bounds index', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.remove(10);
    assert.strictEqual(r.ok, false);
  });
});

// ── getPage ───────────────────────────────────────────────────────────────────

describe('createPositionStore — getPage', () => {
  /** Add n NFT entries with unique token IDs and wallet addresses. */
  function fillStore(n) {
    const store = createPositionStore();
    for (let i = 0; i < n; i++) {
      store.add(makeNft(i + 1, `0x${String(i + 1).padStart(40, '0')}`));
    }
    return store;
  }

  it('returns page 0 with DEFAULT_PAGE_SIZE items when store has many entries', () => {
    const store = fillStore(50);
    const page  = store.getPage(0);
    assert.strictEqual(page.items.length,  DEFAULT_PAGE_SIZE);
    assert.strictEqual(page.page,          0);
    assert.strictEqual(page.totalCount,    50);
    assert.strictEqual(page.hasPrev,       false);
    assert.strictEqual(page.hasNext,       true);
  });

  it('returns correct items on page 1', () => {
    const store   = fillStore(50);
    const page    = store.getPage(1);
    assert.strictEqual(page.items[0].tokenId, String(DEFAULT_PAGE_SIZE + 1));
  });

  it('last page has fewer items when count is not a multiple of pageSize', () => {
    const store = fillStore(25);
    const page  = store.getPage(1, 20);
    assert.strictEqual(page.items.length, 5);
    assert.strictEqual(page.hasNext, false);
  });

  it('clamps page to valid range', () => {
    const store = fillStore(5);
    const page  = store.getPage(99);
    assert.strictEqual(page.page, 0); // only 1 page total, clamped to 0
  });

  it('works with custom pageSize', () => {
    const store = fillStore(30);
    const page  = store.getPage(0, 5);
    assert.strictEqual(page.items.length,  5);
    assert.strictEqual(page.totalPages,    6);
  });

  it('returns empty items array when store is empty', () => {
    const store = createPositionStore();
    const page  = store.getPage(0);
    assert.strictEqual(page.items.length, 0);
    assert.strictEqual(page.totalCount,   0);
    assert.strictEqual(page.totalPages,   1); // always at least 1 page
  });

  it('returns copies — mutations do not affect store', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const page = store.getPage(0);
    page.items[0].tokenId = 'MUTATED';
    assert.strictEqual(store.getActive().tokenId, '12847');
  });
});

// ── getByWallet ───────────────────────────────────────────────────────────────

describe('createPositionStore — getByWallet', () => {
  it('returns all positions for a given wallet', () => {
    const store = createPositionStore();
    const WALLET = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    store.add(makeNft('1', WALLET));
    store.add(makeNft('2', WALLET));
    store.add(makeNft('3', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    const results = store.getByWallet(WALLET);
    assert.strictEqual(results.length, 2);
  });

  it('is case-insensitive for wallet address', () => {
    const store  = createPositionStore();
    const WALLET = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    store.add(makeNft('1', WALLET));
    const lower  = store.getByWallet(WALLET.toLowerCase());
    assert.strictEqual(lower.length, 1);
  });

  it('returns empty array when wallet has no positions', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const r = store.getByWallet('0x0000000000000000000000000000000000000000');
    assert.strictEqual(r.length, 0);
  });
});

// ── clear ─────────────────────────────────────────────────────────────────────

describe('createPositionStore — clear', () => {
  it('removes all entries and resets active', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    store.clear();
    assert.strictEqual(store.count(),    0);
    assert.strictEqual(store.getActive(), null);
  });

  it('allows adding after clear', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    store.clear();
    const r = store.add(ERC_BASE);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store.count(), 1);
  });
});

// ── toArray ───────────────────────────────────────────────────────────────────

describe('createPositionStore — toArray', () => {
  it('returns all entries in insertion order', () => {
    const store = createPositionStore();
    store.add(makeNft('1'));
    store.add(makeNft('2', '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd'));
    const arr = store.toArray();
    assert.strictEqual(arr.length, 2);
    assert.strictEqual(arr[0].tokenId, '1');
    assert.strictEqual(arr[1].tokenId, '2');
  });

  it('returns copies — mutations do not affect store', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const arr = store.toArray();
    arr[0].tokenId = 'MUTATED';
    assert.strictEqual(store.getActive().tokenId, '12847');
  });
});

// ── formatPositionLabel ───────────────────────────────────────────────────────

describe('formatPositionLabel', () => {
  it('formats NFT entry', () => {
    const store = createPositionStore();
    store.add(NFT_BASE);
    const label = formatPositionLabel(store.getActive());
    assert.ok(label.includes('NFT #12847'));
    assert.ok(label.includes('WPLS/USDC'));
    assert.ok(label.includes('0.30%'));
  });

  it('formats ERC-20 entry with truncated contract', () => {
    const store = createPositionStore();
    store.add(ERC_BASE);
    const label = formatPositionLabel(store.getActive());
    assert.ok(label.includes('ERC-20'));
    assert.ok(label.includes('WPLS/DAI'));
  });

  it('formats unknown type gracefully', () => {
    const entry = { positionType: 'unknown', token0: 'A', token1: 'B', fee: 3000 };
    const label = formatPositionLabel(entry);
    assert.ok(label.includes('Unknown'));
    assert.ok(label.includes('A/B'));
  });
});

// ── formatPositionSummary ─────────────────────────────────────────────────────

describe('formatPositionSummary', () => {
  it('includes wallet address abbreviation', () => {
    const store   = createPositionStore();
    store.add(NFT_BASE);
    const summary = formatPositionSummary(store.getActive());
    assert.ok(summary.includes('0xAaAaAa'));
  });

  it('appends in-range ✓ when currentPrice is inside range', () => {
    const store   = createPositionStore();
    // tickLower: -207240 → price ≈ 1.0001^-207240 ≈ very small
    // Use a simple range with known prices for test
    const entry   = { ...NFT_BASE, tickLower: -100, tickUpper: 100 };
    store.add(entry);
    // price 1.0 is inside ticks [-100, 100]
    const summary = formatPositionSummary(store.getActive(), 1.0);
    assert.ok(summary.includes('✓'), `Expected ✓ in: ${summary}`);
  });

  it('appends out-of-range ✗ when currentPrice is outside range', () => {
    const store   = createPositionStore();
    const entry   = { ...NFT_BASE, tickLower: -100, tickUpper: -50 };
    store.add(entry);
    // price 1.0 → tick ≈ 0, which is above tickUpper=-50 → out of range
    const summary = formatPositionSummary(store.getActive(), 1.0);
    assert.ok(summary.includes('✗'), `Expected ✗ in: ${summary}`);
  });

  it('omits range status when currentPrice is not supplied', () => {
    const store   = createPositionStore();
    store.add(NFT_BASE);
    const summary = formatPositionSummary(store.getActive());
    assert.ok(!summary.includes('✓') && !summary.includes('✗'));
  });
});
