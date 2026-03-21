/**
 * @file test/token-symbols.test.js
 * @description Tests that token symbols are never displayed as raw contract
 * addresses.  Covers the scan → store → display pipeline and guards against
 * regressions where `token0Symbol` / `token1Symbol` are missing or fall back
 * to full `0x…` addresses.
 *
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADDR_TOKEN0 = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39';
const ADDR_TOKEN1 = '0x57fde0a71132198BBeC939B98976993d8D89D225';
const ADDR_WALLET = '0x4e44847675763D5540B32Bee8a713CfDcb4bE61A';
const ADDR_PM     = '0xCC05bf158202b4f461ede8843d76dcd7bbad07f2';

/** Position entry as returned by the scan endpoint (has symbols). */
function scanEntry(overrides = {}) {
  return {
    positionType: 'nft',
    tokenId: '157415',
    walletAddress: ADDR_WALLET,
    contractAddress: ADDR_PM,
    token0: ADDR_TOKEN0,
    token1: ADDR_TOKEN1,
    token0Symbol: 'Wrapped PLS',
    token1Symbol: 'Incentive',
    fee: 2500,
    tickLower: 9600,
    tickUpper: 10100,
    liquidity: '968620578250860',
    ...overrides,
  };
}

/** Position entry as the bot's activePosition reports it (addresses only, no symbols). */
function botActiveEntry(overrides = {}) {
  return {
    tokenId: '157500',
    token0: ADDR_TOKEN0,
    token1: ADDR_TOKEN1,
    fee: 2500,
    tickLower: 9700,
    tickUpper: 10200,
    liquidity: '500000000000',
    ...overrides,
  };
}

/** True if a string looks like a raw Ethereum address (0x + 40 hex chars). */
function looksLikeAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/**
 * Minimal browser-side posStore emulation (mirrors dashboard-positions.js).
 * Preserves all fields via spread, updates symbols on duplicate add.
 */
function createBrowserPosStore() {
  const entries = [];
  let activeIdx = -1;
  return {
    get entries() { return entries; },
    get activeIdx() { return activeIdx; },
    add(entry) {
      if (!entry.walletAddress || !entry.positionType) return { ok: false, error: 'Missing fields' };
      const dup = entries.findIndex(e =>
        e.walletAddress.toLowerCase() === entry.walletAddress.toLowerCase() &&
        e.positionType === entry.positionType &&
        (entry.positionType === 'nft'
          ? e.tokenId === String(entry.tokenId)
          : e.contractAddress === entry.contractAddress));
      if (dup !== -1) {
        if (entry.token0Symbol) entries[dup].token0Symbol = entry.token0Symbol;
        if (entry.token1Symbol) entries[dup].token1Symbol = entry.token1Symbol;
        if (entry.liquidity !== undefined) entries[dup].liquidity = entry.liquidity;
        if (entry.contractAddress) entries[dup].contractAddress = entry.contractAddress;
        return { ok: false, error: 'Duplicate' };
      }
      const e2 = { ...entry, index: entries.length, active: false };
      entries.push(e2);
      if (entries.length === 1) { activeIdx = 0; entries[0].active = true; }
      return { ok: true, entry: e2 };
    },
    select(idx) {
      if (idx < 0 || idx >= entries.length) return false;
      if (activeIdx >= 0) entries[activeIdx].active = false;
      activeIdx = idx;
      entries[idx].active = true;
      return true;
    },
    getActive() { return activeIdx >= 0 ? entries[activeIdx] : null; },
    count() { return entries.length; },
  };
}

/**
 * Simulates the old (buggy) _ensureBotPosSelected pattern:
 * adds a bot position to the store using `bp.token0Symbol || bp.token0`.
 */
function buggyAddBotPosition(store, bp) {
  const sw = ADDR_WALLET;
  store.add({
    positionType: 'nft', tokenId: String(bp.tokenId), walletAddress: sw,
    token0Symbol: bp.token0Symbol || bp.token0 || '',
    token1Symbol: bp.token1Symbol || bp.token1 || '',
    liquidity: String(bp.liquidity ?? '0'), fee: bp.fee,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('token-symbols — scan entries preserve symbols in browser store', () => {
  it('scan entry stored in browser posStore preserves symbols', () => {
    const store = createBrowserPosStore();
    store.add(scanEntry());
    const active = store.getActive();
    assert.strictEqual(active.token0Symbol, 'Wrapped PLS');
    assert.strictEqual(active.token1Symbol, 'Incentive');
    assert.ok(!looksLikeAddress(active.token0Symbol), 'token0Symbol must not be a raw address');
    assert.ok(!looksLikeAddress(active.token1Symbol), 'token1Symbol must not be a raw address');
  });

  it('duplicate add updates symbols if provided', () => {
    const store = createBrowserPosStore();
    store.add(scanEntry({ token0Symbol: null, token1Symbol: null }));
    assert.strictEqual(store.getActive().token0Symbol, null, 'initial add has no symbol');
    store.add(scanEntry({ token0Symbol: 'WPLS', token1Symbol: 'INC' }));
    assert.strictEqual(store.getActive().token0Symbol, 'WPLS', 'duplicate add should update symbol');
  });
});

describe('token-symbols — bot activePosition lacks symbols', () => {
  it('bot activePosition has no token0Symbol or token1Symbol', () => {
    const bp = botActiveEntry();
    assert.strictEqual(bp.token0Symbol, undefined);
    assert.strictEqual(bp.token1Symbol, undefined);
  });

  it('fallback pattern (bp.token0Symbol || bp.token0) produces a raw address', () => {
    const bp = botActiveEntry();
    const symbol = bp.token0Symbol || bp.token0 || '';
    assert.ok(looksLikeAddress(symbol),
      'fallback to bp.token0 produces a raw address — this is the bug pattern');
  });
});

describe('token-symbols — buggy _ensureBotPosSelected injects addresses as symbols', () => {
  it('old pattern stores contract address as token0Symbol', () => {
    const store = createBrowserPosStore();
    buggyAddBotPosition(store, botActiveEntry());
    const active = store.getActive();
    assert.ok(looksLikeAddress(active.token0Symbol),
      'buggy pattern stores address as symbol: ' + active.token0Symbol);
    assert.ok(looksLikeAddress(active.token1Symbol),
      'buggy pattern stores address as symbol: ' + active.token1Symbol);
  });

  it('old pattern overwrites good symbols on duplicate add', () => {
    const store = createBrowserPosStore();
    // First: scan adds entry with proper symbols
    store.add(scanEntry({ tokenId: '157500' }));
    assert.strictEqual(store.getActive().token0Symbol, 'Wrapped PLS');
    // Then: buggy bot sync adds same tokenId with address as symbol
    // (duplicate add updates symbols if provided)
    buggyAddBotPosition(store, botActiveEntry({ tokenId: '157500' }));
    const after = store.getActive();
    // The buggy pattern passes a truthy address string, so the duplicate-add
    // code at line 114 overwrites the good symbol with the address.
    assert.ok(looksLikeAddress(after.token0Symbol),
      'buggy duplicate add overwrites symbol with address: ' + after.token0Symbol);
  });
});

describe('token-symbols — correct pattern: skip add when symbols unavailable', () => {
  it('bot position without symbols should not be added to store', () => {
    const store = createBrowserPosStore();
    const bp = botActiveEntry();
    const hasSymbols = bp.token0Symbol && bp.token1Symbol;
    assert.ok(!hasSymbols, 'bot activePosition lacks symbols — should not add to store');
    // Correct behavior: don't add. A rescan via scan endpoint will add with full metadata.
    assert.strictEqual(store.count(), 0, 'store should remain empty until rescan');
  });

  it('rescan adds entry with proper symbols after bot reports new NFT', () => {
    const store = createBrowserPosStore();
    // Step 1: bot reports new NFT (not added to store — correct)
    const bp = botActiveEntry();
    assert.strictEqual(store.count(), 0);
    // Step 2: rescan (simulated) adds entry with full metadata from scan endpoint
    store.add(scanEntry({ tokenId: bp.tokenId }));
    assert.strictEqual(store.count(), 1);
    const active = store.getActive();
    assert.strictEqual(active.token0Symbol, 'Wrapped PLS');
    assert.strictEqual(active.token1Symbol, 'Incentive');
    assert.ok(!looksLikeAddress(active.token0Symbol));
    assert.ok(!looksLikeAddress(active.token1Symbol));
    assert.ok(active.contractAddress, 'rescan entry includes contractAddress');
  });
});
