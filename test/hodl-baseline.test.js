/**
 * @file test/hodl-baseline.test.js
 * @description Unit tests for the hodl-baseline module.
 * Run with: node --test test/hodl-baseline.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Save and restore the real global fetch around every test. */
let _originalFetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  mock.restoreAll();
});

/**
 * Build a minimal mock ethers library for initHodlBaseline tests.
 * @param {object} overrides - Optional overrides for mock behavior.
 * @returns {object} Mock ethersLib with Contract, Interface, ZeroAddress, zeroPadValue.
 */
function mockEthersLib(overrides = {}) {
  const poolAddress = overrides.poolAddress || '0xPool1234';
  return {
    ZeroAddress: '0x' + '0'.repeat(40),
    zeroPadValue: (val, _len) => val.padEnd(66, '0'),
    Contract: class {
      async getPool() { return poolAddress; }
    },
    Interface: class {
      getEvent() {
        return { topicHash: '0xabc123' };
      }
    },
  };
}

/**
 * Build a minimal mock provider.
 * @param {object} overrides - Optional overrides.
 * @returns {object} Mock provider with getLogs, getBlock.
 */
function mockProvider(overrides = {}) {
  return {
    getLogs: async () => 'logs' in overrides ? overrides.logs : [{ blockNumber: 100 }],
    getBlock: async () => 'block' in overrides ? overrides.block : { timestamp: 1700000000 },
  };
}

/** Minimal position object. */
const POSITION = {
  tokenId: 42,
  token0: '0xToken0',
  token1: '0xToken1',
  fee: 3000,
  liquidity: 1000000n,
  tickLower: -1000,
  tickUpper: 1000,
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('initHodlBaseline', () => {
  it('skips if hodlBaseline already set', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = { hodlBaseline: { entryValue: 100 } };
    const updateBotState = mock.fn();

    await initHodlBaseline(mockProvider(), mockEthersLib(), POSITION, botState, updateBotState);

    assert.strictEqual(updateBotState.mock.callCount(), 0, 'should not call updateBotState');
  });

  it('skips when pool address is zero address', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = {};
    const updateBotState = mock.fn();
    const ethers = mockEthersLib({ poolAddress: '0x' + '0'.repeat(40) });

    await initHodlBaseline(mockProvider(), ethers, POSITION, botState, updateBotState);

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it('skips when no mint logs found', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = {};
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider({ logs: [] }),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it('skips when block is null', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = {};
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider({ block: null }),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it('sets fallback flag when GeckoTerminal returns zero prices', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = {};
    const updateBotState = mock.fn();

    // GeckoTerminal returns empty candles
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });

    await initHodlBaseline(mockProvider(), mockEthersLib(), POSITION, botState, updateBotState);

    assert.strictEqual(updateBotState.mock.callCount(), 1, 'should call updateBotState with fallback flag');
    assert.strictEqual(botState.hodlBaselineFallback, true);
    assert.strictEqual(botState.hodlBaseline, undefined, 'should not set hodlBaseline');
  });

  it('catches and logs errors without throwing', async () => {
    const { initHodlBaseline } = require('../src/hodl-baseline');
    const botState = {};
    const updateBotState = mock.fn();

    // Provider that throws
    const badProvider = {
      getLogs: async () => { throw new Error('RPC down'); },
    };

    // Should not throw
    await initHodlBaseline(badProvider, mockEthersLib(), POSITION, botState, updateBotState);

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });
});

describe('_positionValueUsd', () => {
  it('computes USD value from position amounts and prices', () => {
    const { _positionValueUsd } = require('../src/hodl-baseline');

    // Mock range-math — the require inside _positionValueUsd will pick this up
    // since it uses a dynamic require. We need to test with real range-math.
    const position = {
      liquidity: 1000000n,
      tickLower: -1000,
      tickUpper: 1000,
    };
    const poolState = {
      tick: 0,
      decimals0: 18,
      decimals1: 18,
    };

    // With tick=0 (price ratio 1:1), and symmetric range, amounts should be roughly equal
    const value = _positionValueUsd(position, poolState, 2.0, 3.0);
    assert.ok(typeof value === 'number', 'should return a number');
    assert.ok(value > 0, 'should return positive value');
  });
});
