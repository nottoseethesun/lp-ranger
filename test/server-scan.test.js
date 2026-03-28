/**
 * @file test/server-scan.test.js
 * @description Tests for the LP position scan handlers.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { createScanHandlers } = require('../src/server-scan');

// ── Helpers ─────────────────────────────────────────────────────────

function mockDeps(overrides) {
  return {
    walletManager: {
      getStatus: () => ({
        loaded: true,
        address: '0x4e44847675763D5540B32Bee8a713CfDcb4bE61A',
      }),
      ...overrides?.walletManager,
    },
    jsonResponse: overrides?.jsonResponse
      || ((_res, _code, body) => body),
    readJsonBody: overrides?.readJsonBody
      || (async () => ({})),
    setGlobalScanStatus: overrides?.setGlobalScanStatus
      || (() => {}),
  };
}

// ── createScanHandlers ──────────────────────────────────────────────

describe('server-scan — createScanHandlers', () => {
  it('returns handler functions', () => {
    const h = createScanHandlers(mockDeps());
    assert.strictEqual(
      typeof h._handlePositionsScan, 'function',
    );
    assert.strictEqual(
      typeof h._handlePositionsRefresh, 'function',
    );
    assert.strictEqual(
      typeof h.resolveTokenSymbol, 'function',
    );
  });
});

// ── _handlePositionsScan — wallet not loaded ────────────────────────

describe('server-scan — scan rejects without wallet', () => {
  it('returns 400 when wallet not loaded', async () => {
    const responses = [];
    const h = createScanHandlers(mockDeps({
      walletManager: {
        getStatus: () => ({ loaded: false }),
      },
      jsonResponse: (_res, code, body) =>
        responses.push({ code, body }),
    }));
    await h._handlePositionsScan({}, {});
    assert.strictEqual(responses[0].code, 400);
    assert.strictEqual(responses[0].body.ok, false);
  });
});

// ── _handlePositionsRefresh — no cache ──────────────────────────────

describe('server-scan — refresh with no cache', () => {
  it('returns empty when no cache exists', async () => {
    const responses = [];
    const h = createScanHandlers(mockDeps({
      jsonResponse: (_res, code, body) =>
        responses.push({ code, body }),
    }));
    // No cache file → returns empty
    await h._handlePositionsRefresh({}, {});
    assert.strictEqual(responses[0].code, 200);
    assert.deepStrictEqual(
      responses[0].body.poolTicks, {},
    );
    assert.deepStrictEqual(
      responses[0].body.liquidities, {},
    );
  });
});

// ── _handlePositionsRefresh — wallet not loaded ─────────────────────

describe('server-scan — refresh rejects without wallet', () => {
  it('returns 400 when wallet not loaded', async () => {
    const responses = [];
    const h = createScanHandlers(mockDeps({
      walletManager: {
        getStatus: () => ({ loaded: false }),
      },
      jsonResponse: (_res, code, body) =>
        responses.push({ code, body }),
    }));
    await h._handlePositionsRefresh({}, {});
    assert.strictEqual(responses[0].code, 400);
  });
});

// ── resolveTokenSymbol ──────────────────────────────────────────────

describe('server-scan — resolveTokenSymbol', () => {
  it('returns ? for null address', async () => {
    const h = createScanHandlers(mockDeps());
    const sym = await h.resolveTokenSymbol({}, null);
    assert.strictEqual(sym, '?');
  });

  it('returns truncated address on RPC failure', async () => {
    const h = createScanHandlers(mockDeps());
    // Passing a non-provider triggers the catch
    const sym = await h.resolveTokenSymbol(
      null,
      '0x1234567890abcdef1234567890abcdef12345678',
    );
    assert.ok(sym.includes('0x1234'));
    assert.ok(sym.includes('5678'));
  });
});
