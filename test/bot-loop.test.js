/**
 * @file test/bot-loop.test.js
 * @description Tests for src/bot-loop.js — resolvePrivateKey, startBotLoop,
 * pollCycle, appendLog, createProviderWithFallback, forceRebalance.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const {
  createProviderWithFallback,
  resolvePrivateKey,
} = require('../src/bot-loop');
const { CHAIN } = require('../src/config');
const { ADDR, _poll } = require('./_bot-loop-helpers');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockEthersLib({
  primaryFails = false,
  fallbackFails = false,
} = {}) {
  const calls = [];
  function JsonRpcProvider(url) {
    calls.push(url);
    this.url = url;
    this.getBlockNumber = async () => {
      if (primaryFails && url === 'https://primary.rpc') {
        throw new Error('primary unreachable');
      }
      if (fallbackFails && url === 'https://fallback.rpc') {
        throw new Error('fallback unreachable');
      }
      return 12345;
    };
  }
  return { JsonRpcProvider, calls };
}

// ── RPC fallback (via bot-loop directly) ─────────────────────────────────────

describe('bot-loop: createProviderWithFallback', () => {
  const PRI = 'https://primary.rpc',
    FALL = 'https://fallback.rpc';
  it('uses primary when it is reachable', async () => {
    const p = await createProviderWithFallback(PRI, FALL, mockEthersLib());
    assert.strictEqual(p.url, PRI);
  });
  it('falls back when primary is unreachable', async () => {
    const p = await createProviderWithFallback(
      PRI,
      FALL,
      mockEthersLib({ primaryFails: true }),
    );
    assert.strictEqual(p.url, FALL);
  });
  it('throws when both are unreachable', async () => {
    await assert.rejects(
      () =>
        createProviderWithFallback(
          PRI,
          FALL,
          mockEthersLib({ primaryFails: true, fallbackFails: true }),
        ),
      { message: 'fallback unreachable' },
    );
  });
});

// ── Gas price patch (PulseChain getFeeData fix) ──────────────────────────────

describe('bot-loop: _patchFeeData via createProviderWithFallback', () => {
  const PRI = 'https://primary.rpc',
    FALL = 'https://fallback.rpc';

  /** Helper: create a mock ethers lib with getFeeData on the provider. */
  function _feeLib(getFeeData, send) {
    const lib = mockEthersLib();
    const orig = lib.JsonRpcProvider;
    lib.JsonRpcProvider = function (url) {
      orig.call(this, url);
      this.getFeeData = getFeeData;
      if (send) this.send = send;
    };
    return lib;
  }
  it('returns original feeData when gasPrice > 0', async () => {
    const p = await createProviderWithFallback(
      PRI,
      FALL,
      _feeLib(async () => ({
        gasPrice: 5000n,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      })),
    );
    const m = CHAIN.gasPriceMultiplier || 1;
    const expected = 5000n * BigInt(Math.round(m * 1000)) / 1000n;
    assert.strictEqual((await p.getFeeData()).gasPrice, expected);
  });
  it('falls back to maxFeePerGas when gasPrice is 0', async () => {
    const p = await createProviderWithFallback(
      PRI,
      FALL,
      _feeLib(async () => ({
        gasPrice: 0n,
        maxFeePerGas: 8000n,
        maxPriorityFeePerGas: 100n,
      })),
    );
    const m = CHAIN.gasPriceMultiplier || 1;
    const expected = 8000n * BigInt(Math.round(m * 1000)) / 1000n;
    // Patch returns only gasPrice (type 0) using maxFeePerGas as base
    assert.strictEqual((await p.getFeeData()).gasPrice, expected);
    assert.strictEqual((await p.getFeeData()).maxFeePerGas, null);
  });
  it('falls back to eth_gasPrice when feeData returns all zeros', async () => {
    const p = await createProviderWithFallback(
      PRI,
      FALL,
      _feeLib(
        async () => ({
          gasPrice: 0n,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
        async (method) => {
          if (method === 'eth_gasPrice') return '0x2540be400';
          throw new Error('unexpected');
        },
      ),
    );
    assert.strictEqual((await p.getFeeData()).gasPrice, 10_000_000_000n);
  });
  it('returns original zero feeData when eth_gasPrice also returns 0', async () => {
    const p = await createProviderWithFallback(
      PRI,
      FALL,
      _feeLib(
        async () => ({
          gasPrice: 0n,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
        async () => '0x0',
      ),
    );
    assert.strictEqual((await p.getFeeData()).gasPrice, 0n);
  });
  it('skips patching when provider has no getFeeData', async () => {
    const p = await createProviderWithFallback(PRI, FALL, mockEthersLib());
    assert.strictEqual(p.getFeeData, undefined);
  });
});

// ── resolvePrivateKey ────────────────────────────────────────────────────────

describe('bot-loop: resolvePrivateKey', () => {
  const cfg = require('../src/config');
  let orig;
  beforeEach(() => {
    orig = {
      pk: cfg.PRIVATE_KEY,
      kf: cfg.KEY_FILE,
      kp: cfg.KEY_PASSWORD,
      wp: cfg.WALLET_PASSWORD,
    };
  });
  afterEach(() => {
    cfg.PRIVATE_KEY = orig.pk;
    cfg.KEY_FILE = orig.kf;
    cfg.KEY_PASSWORD = orig.kp;
    cfg.WALLET_PASSWORD = orig.wp;
  });
  it('returns PRIVATE_KEY when valid 32-byte hex', async () => {
    const validKey = '0x' + 'ab'.repeat(32);
    cfg.PRIVATE_KEY = validKey;
    assert.strictEqual(
      await resolvePrivateKey({ askPassword: null }),
      validKey,
    );
  });
  it('rejects placeholder PRIVATE_KEY as invalid', async () => {
    cfg.PRIVATE_KEY = '0xYOUR_WALLET_PRIVATE_KEY';
    cfg.KEY_FILE = null;
    cfg.WALLET_PASSWORD = null;
    assert.strictEqual(
      await resolvePrivateKey({ askPassword: null }),
      null,
    );
  });
  it('returns null when no sources available', async () => {
    cfg.PRIVATE_KEY = null;
    cfg.KEY_FILE = null;
    cfg.WALLET_PASSWORD = null;
    assert.strictEqual(
      await resolvePrivateKey({ askPassword: null }),
      null,
    );
  });
  it('returns null for KEY_FILE without password in non-interactive mode', async () => {
    cfg.PRIVATE_KEY = null;
    cfg.KEY_FILE = '/tmp/fake-keyfile';
    cfg.KEY_PASSWORD = null;
    assert.strictEqual(
      await resolvePrivateKey({ askPassword: null }),
      null,
    );
  });
  it('PRIVATE_KEY takes priority over KEY_FILE', async () => {
    const validKey = '0x' + 'cd'.repeat(32);
    cfg.PRIVATE_KEY = validKey;
    cfg.KEY_FILE = '/tmp/fake-keyfile';
    cfg.KEY_PASSWORD = 'pw';
    assert.strictEqual(
      await resolvePrivateKey({ askPassword: null }),
      validKey,
    );
  });
});

// ── pollCycle via bot-loop ───────────────────────────────────────────────────

describe('bot-loop: pollCycle', () => {
  it('returns rebalanced:false when in range', async () => {
    const { r } = await _poll(0);
    assert.strictEqual(r.rebalanced, false);
  });
  it('rebalances when out of range', async () => {
    const { r, deps } = await _poll(600);
    assert.strictEqual(r.rebalanced, true);
    assert.strictEqual(deps.position.tokenId, '99');
  });
  it('does not rebalance when throttled', async () => {
    const { r } = await _poll(700, {
      botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      setupDeps: (d) => {
        d.throttle.canRebalance = () => ({
          allowed: false,
          msUntilAllowed: 60000,
          reason: 'min_interval',
        });
      },
    });
    assert.strictEqual(r.rebalanced, false);
  });
  it('does not rebalance in dry-run mode', async () => {
    const { r } = await _poll(700, {
      dryRun: true,
      botState: { rebalanceOutOfRangeThresholdPercent: 0 },
    });
    assert.strictEqual(r.rebalanced, false);
  });
  it('overrides pnlSnapshot with real on-chain values when tracker is present', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1.0,
      lowerPrice: 0.8,
      upperPrice: 1.2,
      token0UsdPrice: 1.0,
      token1UsdPrice: 1.0,
    });
    const { r, captured } = await _poll(0, {
      tracker,
      captureState: true,
    });
    assert.strictEqual(r.rebalanced, false);
    if (captured.pnlSnapshot) {
      for (const k of [
        'currentValue',
        'priceChangePnl',
        'netReturn',
        'cumulativePnl',
      ]) {
        assert.strictEqual(typeof captured.pnlSnapshot[k], 'number');
      }
    }
  });
});

describe('bot-loop: forceRebalance', () => {
  it('rebalances even when in range if forceRebalance is set', async () => {
    const { r } = await _poll(0, {
      botState: {
        forceRebalance: true,
        rebalanceOutOfRangeThresholdPercent: 20,
        slippagePct: 0.5,
      },
    });
    assert.strictEqual(
      r.rebalanced,
      true,
      'should rebalance when forced even if in range',
    );
  });
  it('skips throttle check on forced rebalance', async () => {
    const { r } = await _poll(0, {
      botState: {
        forceRebalance: true,
        rebalanceOutOfRangeThresholdPercent: 20,
        slippagePct: 0.5,
      },
      setupDeps: (d) => {
        d.throttle.canRebalance = () => ({
          allowed: false,
          msUntilAllowed: 60000,
          reason: 'daily_limit',
        });
      },
    });
    assert.strictEqual(
      r.rebalanced,
      true,
      'should bypass throttle when forced',
    );
  });
  it('clears forceRebalance flag after attempt', async () => {
    const botState = {
      forceRebalance: true,
      rebalanceOutOfRangeThresholdPercent: 20,
      slippagePct: 0.5,
    };
    const { r } = await _poll(0, {
      botState,
      captureState: false,
      setupDeps: (d) => {
        d.dispatch[ADDR.pm].mint = async () => {
          throw new Error('Price slippage check');
        };
      },
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(
      botState.forceRebalance,
      false,
      'flag should clear after attempt',
    );
  });
});
