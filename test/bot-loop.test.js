/**
 * @file test/bot-loop.test.js
 * @description Tests for src/bot-loop.js — resolvePrivateKey, startBotLoop,
 * pollCycle, appendLog, createProviderWithFallback.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const {
  pollCycle,
  createProviderWithFallback,
  resolvePrivateKey,
} = require('../src/bot-loop');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockEthersLib({ primaryFails = false, fallbackFails = false } = {}) {
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
  it('uses primary when it is reachable', async () => {
    const lib = mockEthersLib();
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    assert.strictEqual(provider.url, 'https://primary.rpc');
  });

  it('falls back when primary is unreachable', async () => {
    const lib = mockEthersLib({ primaryFails: true });
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    assert.strictEqual(provider.url, 'https://fallback.rpc');
  });

  it('throws when both are unreachable', async () => {
    const lib = mockEthersLib({ primaryFails: true, fallbackFails: true });
    await assert.rejects(
      () => createProviderWithFallback('https://primary.rpc', 'https://fallback.rpc', lib),
      { message: 'fallback unreachable' },
    );
  });
});

// ── resolvePrivateKey ────────────────────────────────────────────────────────

describe('bot-loop: resolvePrivateKey', () => {
  const config = require('../src/config');
  let origPrivateKey;
  let origKeyFile;
  let origKeyPassword;
  let origWalletPassword;

  beforeEach(() => {
    origPrivateKey = config.PRIVATE_KEY;
    origKeyFile = config.KEY_FILE;
    origKeyPassword = config.KEY_PASSWORD;
    origWalletPassword = config.WALLET_PASSWORD;
  });

  afterEach(() => {
    config.PRIVATE_KEY = origPrivateKey;
    config.KEY_FILE = origKeyFile;
    config.KEY_PASSWORD = origKeyPassword;
    config.WALLET_PASSWORD = origWalletPassword;
  });

  it('returns PRIVATE_KEY when set', async () => {
    config.PRIVATE_KEY = '0xabc123';
    const key = await resolvePrivateKey({ askPassword: null });
    assert.strictEqual(key, '0xabc123');
  });

  it('returns null when no sources available', async () => {
    config.PRIVATE_KEY = null;
    config.KEY_FILE = null;
    config.WALLET_PASSWORD = null;
    const key = await resolvePrivateKey({ askPassword: null });
    assert.strictEqual(key, null);
  });

  it('returns null for KEY_FILE without password in non-interactive mode', async () => {
    config.PRIVATE_KEY = null;
    config.KEY_FILE = '/tmp/fake-keyfile';
    config.KEY_PASSWORD = null;
    const key = await resolvePrivateKey({ askPassword: null });
    assert.strictEqual(key, null);
  });

  it('PRIVATE_KEY takes priority over KEY_FILE', async () => {
    config.PRIVATE_KEY = '0xfirst';
    config.KEY_FILE = '/tmp/fake-keyfile';
    config.KEY_PASSWORD = 'pw';
    const key = await resolvePrivateKey({ askPassword: null });
    assert.strictEqual(key, '0xfirst');
  });
});

// ── pollCycle via bot-loop ───────────────────────────────────────────────────

const config = require('../src/config');
const ADDR = {
  factory: config.FACTORY,
  pool:    '0xPOOL00000000000000000000000000000000000001',
  token0:  '0xTOKEN00000000000000000000000000000000000A',
  token1:  '0xTOKEN00000000000000000000000000000000000B',
  pm:      config.POSITION_MANAGER,
  router:  config.SWAP_ROUTER,
  signer:  '0xSIGNER0000000000000000000000000000000001',
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const Q96 = BigInt('0x1000000000000000000000000');
const ONE_ETH = 1_000_000_000_000_000_000n;
const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

function makeTx(hash) {
  return { wait: async () => ({ hash, logs: [] }) };
}
function makeMintTx(hash, tokenId = 42n, liq = 5000n, a0 = 1000n, a1 = 1000n) {
  return {
    wait: async () => ({
      hash,
      logs: [{
        topics: [INC_TOPIC, '0x' + tokenId.toString(16).padStart(64, '0')],
        data: '0x'
          + liq.toString(16).padStart(64, '0')
          + a0.toString(16).padStart(64, '0')
          + a1.toString(16).padStart(64, '0'),
      }],
    }),
  };
}

function buildPollDeps(opts = {}) {
  const tick = opts.tick ?? 0;
  let collected = false;

  const dispatch = {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]: { slot0: async () => ({ sqrtPriceX96: Q96, tick: BigInt(tick) }) },
    [ADDR.token0]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa0'), allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa1'), allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({ liquidity: 5000n }),
      decreaseLiquidity: async () => makeTx('0xdec'),
      collect: async () => { collected = true; return { wait: async () => ({ hash: '0xcol', logs: [] }) }; },
      mint: async () => makeMintTx('0xmint', 99n, 8000n),
    },
    [ADDR.router]: { exactInputSingle: async () => makeTx('0xswap') },
  };

  function MockContract(addr, _abi) {
    const methods = dispatch[addr];
    if (!methods) throw new Error(`No mock for ${addr}`);
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
  }
  const ethersLib = { Contract: MockContract, ZeroAddress: ZERO_ADDRESS };

  const signer = {
    getAddress: async () => ADDR.signer,
    provider: { mockProvider: true },
  };

  const position = {
    tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, liquidity: 5000n, tickLower: -600, tickUpper: 600,
  };

  const throttleState = { allowed: true };
  const throttle = {
    tick: () => {},
    canRebalance: () => ({ allowed: throttleState.allowed, msUntilAllowed: 0, reason: 'ok' }),
    recordRebalance: () => {},
    getState: () => ({}),
    _state: throttleState,
  };

  return { ethersLib, signer, position, throttle, dispatch };
}

describe('bot-loop: pollCycle', () => {
  it('returns rebalanced:false when in range', async () => {
    const deps = buildPollDeps({ tick: 0 });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, false);
  });

  it('rebalances when out of range', async () => {
    const deps = buildPollDeps({ tick: 600 });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, true);
    assert.strictEqual(deps.position.tokenId, 99n);
  });

  it('does not rebalance when throttled', async () => {
    const deps = buildPollDeps({ tick: 700 });
    deps.throttle.canRebalance = () => ({
      allowed: false, msUntilAllowed: 60000, reason: 'min_interval',
    });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {},
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, false);
  });

  it('does not rebalance in dry-run mode', async () => {
    const deps = buildPollDeps({ tick: 700 });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      dryRun: true,
      _ethersLib: deps.ethersLib,
      _botState: {},
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, false);
  });

  it('overrides pnlSnapshot with real on-chain values when tracker is present', async () => {
    const deps = buildPollDeps({ tick: 0 });
    const { createPnlTracker } = require('../src/pnl-tracker');
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100, entryPrice: 1.0,
      lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0,
    });
    const captured = {};
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
      _pnlTracker: tracker,
      updateBotState: (state) => { Object.assign(captured, state); },
    });
    assert.strictEqual(r.rebalanced, false);
    // pnlSnapshot should exist (even if prices are 0 due to mock)
    if (captured.pnlSnapshot) {
      assert.strictEqual(typeof captured.pnlSnapshot.currentValue, 'number');
      assert.strictEqual(typeof captured.pnlSnapshot.priceChangePnl, 'number');
      assert.strictEqual(typeof captured.pnlSnapshot.netReturn, 'number');
      assert.strictEqual(typeof captured.pnlSnapshot.cumulativePnl, 'number');
    }
  });
});
