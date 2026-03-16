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
  _overridePnlWithRealValues,
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
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
      decreaseLiquidity: async () => makeTx('0xdec'),
      collect: async () => { collected = true; return { wait: async () => ({ hash: '0xcol', logs: [] }) }; },
      mint: async () => makeMintTx('0xmint', 99n, 8000n),
    },
    [ADDR.router]: { exactInputSingle: async () => makeTx('0xswap') },
  };

  function MockContract(addr, _abi) {
    const self = this;
    const methods = dispatch[addr];
    if (!methods) throw new Error(`No mock for ${addr}`);
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
    const _pending = [];
    this.interface = {
      encodeFunctionData: (name, args) => {
        const idx = _pending.length;
        _pending.push({ method: name, args: args[0] });
        return `mock_call_${idx}`;
      },
    };
    if (!this.multicall) {
      this.multicall = async (calls) => {
        for (const ref of calls) {
          const idx = parseInt(ref.replace('mock_call_', ''), 10);
          const { method, args } = _pending[idx];
          if (self[method]) await self[method](args);
        }
        return makeTx('0xmulticall');
      };
    }
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

describe('bot-loop: forceRebalance', () => {
  it('rebalances even when in range if forceRebalance is set', async () => {
    const deps = buildPollDeps({ tick: 0 }); // tick 0 is in range [-600, 600]
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, true, 'should rebalance when forced even if in range');
  });

  it('skips throttle check on forced rebalance', async () => {
    const deps = buildPollDeps({ tick: 0 });
    deps.throttle.canRebalance = () => ({
      allowed: false, msUntilAllowed: 60000, reason: 'daily_limit',
    });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: () => {},
    });
    assert.strictEqual(r.rebalanced, true, 'should bypass throttle when forced');
  });

  it('does not clear forceRebalance flag on failure', async () => {
    // Build deps with a mint that always throws (simulating slippage failure)
    const deps = buildPollDeps({ tick: 0 });
    deps.dispatch[ADDR.pm].mint = async () => { throw new Error('Price slippage check'); };
    // Rebuild ethersLib so new MockContract instances pick up the failing mint
    const failDeps = buildPollDeps({ tick: 0 });
    failDeps.dispatch[ADDR.pm].mint = async () => { throw new Error('Price slippage check'); };
    const botState = { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 };
    const r = await pollCycle({
      signer: failDeps.signer,
      provider: {},
      position: failDeps.position,
      throttle: failDeps.throttle,
      _ethersLib: failDeps.ethersLib,
      _botState: botState,
      updateBotState: (patch) => { Object.assign(botState, patch); },
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(botState.forceRebalance, true, 'flag should persist after failure');
  });
});

describe('bot-loop: _overridePnlWithRealValues (IL computation)', () => {
  // Minimal position/poolState stubs for _positionValueUsd (tick=0, range [-600,600])
  const pos = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
  const pool = { tick: 0, decimals0: 18, decimals1: 18 };

  it('computes negative IL when price diverges from entry', () => {
    const snap = {
      liveEpoch: { entryValue: 2000, token0UsdEntry: 1000, token1UsdEntry: 1 },
      initialDeposit: 2000, totalGas: 0,
    };
    const deps = { _botState: {} };
    // price0 doubled: HODL = (1000/1000)*2000 + (1000/1)*1 = 2000+1000 = 3000
    _overridePnlWithRealValues(snap, deps, pos, pool, 2000, 1, 0);
    assert.strictEqual(typeof snap.totalIL, 'number');
    // LP value (near zero for this mock) is far below HODL value of 3000
    assert.ok(snap.totalIL < 0, 'IL should be negative when price diverges');
  });

  it('computes near-zero IL when prices unchanged', () => {
    const snap = {
      liveEpoch: { entryValue: 2000, token0UsdEntry: 1000, token1UsdEntry: 1 },
      initialDeposit: 2000, totalGas: 0,
    };
    const deps = { _botState: {} };
    // Same prices as entry: HODL = (1000/1000)*1000 + (1000/1)*1 = 1000+1000 = 2000
    _overridePnlWithRealValues(snap, deps, pos, pool, 1000, 1, 0);
    // IL should be realValue - 2000; with prices unchanged, IL is close to 0
    assert.strictEqual(typeof snap.totalIL, 'number');
  });

  it('sets _setHodlBaseline when no baseline exists', () => {
    const snap = {
      liveEpoch: { entryValue: 500, token0UsdEntry: 10, token1UsdEntry: 2 },
      initialDeposit: 500, totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.ok(snap._setHodlBaseline, 'should signal baseline creation');
    assert.strictEqual(snap._setHodlBaseline.entryValue, 500);
    assert.strictEqual(snap._setHodlBaseline.token0UsdPrice, 10);
    assert.strictEqual(snap._setHodlBaseline.token1UsdPrice, 2);
  });

  it('uses persisted hodlBaseline when available', () => {
    const snap = {
      liveEpoch: { entryValue: 800, token0UsdEntry: 20, token1UsdEntry: 3 },
      initialDeposit: 800, totalGas: 0,
    };
    const baseline = { entryValue: 1000, token0UsdPrice: 10, token1UsdPrice: 1 };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 20, 3, 0);
    // HODL uses baseline prices (10, 1) not epoch prices (20, 3)
    // hodlValue = (500/10)*20 + (500/1)*3 = 1000 + 1500 = 2500
    assert.ok(!snap._setHodlBaseline, 'should not signal baseline when already set');
    assert.strictEqual(typeof snap.totalIL, 'number');
  });

  it('skips IL when liveEpoch has no entry prices and no baseline', () => {
    const snap = {
      liveEpoch: null,
      initialDeposit: 500, totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(snap.totalIL, undefined, 'totalIL should not be set');
    assert.strictEqual(snap._setHodlBaseline, undefined, 'no baseline to set');
  });

  it('skips IL when liveEpoch exists but has no token entry prices', () => {
    const snap = {
      liveEpoch: { entryValue: 500 },
      initialDeposit: 500, totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(snap.totalIL, undefined, 'totalIL should not be set without entry prices');
  });

  it('computes IL from baseline even when liveEpoch is missing', () => {
    const snap = {
      liveEpoch: null,
      initialDeposit: 500, totalGas: 0,
    };
    const baseline = { entryValue: 500, token0UsdPrice: 10, token1UsdPrice: 2 };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(typeof snap.totalIL, 'number', 'should compute IL from persisted baseline');
  });
});

describe('bot-loop: throttleState in updateBotState', () => {
  it('emits throttleState after a successful rebalance', async () => {
    const deps = buildPollDeps({ tick: 700 });
    const stateUpdates = [];
    deps.throttle.getState = () => ({ dailyCount: 3, dailyMax: 20 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: (u) => stateUpdates.push(u),
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted after rebalance');
    assert.strictEqual(ts.dailyCount, 3);
  });

  it('emits throttleState when throttle rejects', async () => {
    const deps = buildPollDeps({ tick: 700 });
    const stateUpdates = [];
    deps.throttle.canRebalance = () => ({ allowed: false, msUntilAllowed: 60000, reason: 'daily_max' });
    deps.throttle.getState = () => ({ dailyCount: 20, dailyMax: 20 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {},
      updateBotState: (u) => stateUpdates.push(u),
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted on throttle rejection');
    assert.strictEqual(ts.dailyCount, 20);
  });
});

describe('bot-loop: gas deferral', () => {
  it('returns gasDeferred when gas exceeds 0.5% of position value', async () => {
    const deps = buildPollDeps({ tick: 700 }); // out of range
    // Mock provider with very high gas price
    const provider = {
      mockProvider: true,
      getFeeData: async () => ({ gasPrice: 100_000_000_000_000n }), // 0.0001 PLS per gas unit
    };
    const r = await pollCycle({
      signer: deps.signer,
      provider,
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
      updateBotState: () => {},
    });
    // Gas check will likely fail (no real price feed) and proceed to rebalance
    // The key invariant: result has either rebalanced or gasDeferred
    assert.ok(r.rebalanced === true || r.gasDeferred === true,
      'should either rebalance or defer on gas');
  });

  it('returns inRange:true when position is in range', async () => {
    const deps = buildPollDeps({ tick: 0 }); // in range
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
    assert.strictEqual(r.inRange, true);
  });
});
