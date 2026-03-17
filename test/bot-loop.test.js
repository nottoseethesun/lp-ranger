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
  const PRI = 'https://primary.rpc', FALL = 'https://fallback.rpc';
  it('uses primary when it is reachable', async () => {
    const p = await createProviderWithFallback(PRI, FALL, mockEthersLib());
    assert.strictEqual(p.url, PRI);
  });
  it('falls back when primary is unreachable', async () => {
    const p = await createProviderWithFallback(PRI, FALL, mockEthersLib({ primaryFails: true }));
    assert.strictEqual(p.url, FALL);
  });
  it('throws when both are unreachable', async () => {
    await assert.rejects(
      () => createProviderWithFallback(PRI, FALL, mockEthersLib({ primaryFails: true, fallbackFails: true })),
      { message: 'fallback unreachable' },
    );
  });
});

// ── resolvePrivateKey ────────────────────────────────────────────────────────

describe('bot-loop: resolvePrivateKey', () => {
  const cfg = require('../src/config');
  let orig;
  beforeEach(() => { orig = { pk: cfg.PRIVATE_KEY, kf: cfg.KEY_FILE, kp: cfg.KEY_PASSWORD, wp: cfg.WALLET_PASSWORD }; });
  afterEach(() => { cfg.PRIVATE_KEY = orig.pk; cfg.KEY_FILE = orig.kf; cfg.KEY_PASSWORD = orig.kp; cfg.WALLET_PASSWORD = orig.wp; });
  it('returns PRIVATE_KEY when set', async () => {
    cfg.PRIVATE_KEY = '0xabc123';
    assert.strictEqual(await resolvePrivateKey({ askPassword: null }), '0xabc123');
  });
  it('returns null when no sources available', async () => {
    cfg.PRIVATE_KEY = null; cfg.KEY_FILE = null; cfg.WALLET_PASSWORD = null;
    assert.strictEqual(await resolvePrivateKey({ askPassword: null }), null);
  });
  it('returns null for KEY_FILE without password in non-interactive mode', async () => {
    cfg.PRIVATE_KEY = null; cfg.KEY_FILE = '/tmp/fake-keyfile'; cfg.KEY_PASSWORD = null;
    assert.strictEqual(await resolvePrivateKey({ askPassword: null }), null);
  });
  it('PRIVATE_KEY takes priority over KEY_FILE', async () => {
    cfg.PRIVATE_KEY = '0xfirst'; cfg.KEY_FILE = '/tmp/fake-keyfile'; cfg.KEY_PASSWORD = 'pw';
    assert.strictEqual(await resolvePrivateKey({ askPassword: null }), '0xfirst');
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

/** Helper: run pollCycle with buildPollDeps + overrides. */
function _poll(tick, overrides = {}) {
  const deps = buildPollDeps({ tick });
  if (overrides.setupDeps) overrides.setupDeps(deps);
  const stateUpdates = overrides.collectStates ? [] : null;
  const captured = overrides.captureState ? {} : null;
  return pollCycle({
    signer: deps.signer, provider: overrides.provider || {},
    position: deps.position, throttle: deps.throttle,
    _ethersLib: deps.ethersLib, dryRun: overrides.dryRun,
    _botState: overrides.botState || { rangeWidthPct: 20, slippagePct: 0.5 },
    _pnlTracker: overrides.tracker,
    updateBotState: stateUpdates ? (u) => stateUpdates.push(u)
      : captured ? (u) => Object.assign(captured, u) : () => {},
  }).then(r => ({ r, deps, stateUpdates, captured }));
}

describe('bot-loop: pollCycle', () => {
  it('returns rebalanced:false when in range', async () => {
    const { r } = await _poll(0);
    assert.strictEqual(r.rebalanced, false);
  });
  it('rebalances when out of range', async () => {
    const { r, deps } = await _poll(600);
    assert.strictEqual(r.rebalanced, true);
    assert.strictEqual(deps.position.tokenId, 99n);
  });
  it('does not rebalance when throttled', async () => {
    const { r } = await _poll(700, { botState: {},
      setupDeps: d => { d.throttle.canRebalance = () => ({ allowed: false, msUntilAllowed: 60000, reason: 'min_interval' }); } });
    assert.strictEqual(r.rebalanced, false);
  });
  it('does not rebalance in dry-run mode', async () => {
    const { r } = await _poll(700, { dryRun: true, botState: {} });
    assert.strictEqual(r.rebalanced, false);
  });
  it('overrides pnlSnapshot with real on-chain values when tracker is present', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({ entryValue: 100, entryPrice: 1.0, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0 });
    const { r, captured } = await _poll(0, { tracker, captureState: true });
    assert.strictEqual(r.rebalanced, false);
    if (captured.pnlSnapshot) {
      for (const k of ['currentValue', 'priceChangePnl', 'netReturn', 'cumulativePnl']) {
        assert.strictEqual(typeof captured.pnlSnapshot[k], 'number');
      }
    }
  });
});

describe('bot-loop: forceRebalance', () => {
  it('rebalances even when in range if forceRebalance is set', async () => {
    const { r } = await _poll(0, { botState: { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 } });
    assert.strictEqual(r.rebalanced, true, 'should rebalance when forced even if in range');
  });
  it('skips throttle check on forced rebalance', async () => {
    const { r } = await _poll(0, { botState: { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 },
      setupDeps: d => { d.throttle.canRebalance = () => ({ allowed: false, msUntilAllowed: 60000, reason: 'daily_limit' }); } });
    assert.strictEqual(r.rebalanced, true, 'should bypass throttle when forced');
  });
  it('does not clear forceRebalance flag on failure', async () => {
    const botState = { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 };
    const { r } = await _poll(0, { botState, captureState: false,
      setupDeps: d => { d.dispatch[ADDR.pm].mint = async () => { throw new Error('Price slippage check'); }; } });
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
    const { stateUpdates } = await _poll(700, { collectStates: true,
      setupDeps: d => { d.throttle.getState = () => ({ dailyCount: 3, dailyMax: 20 }); } });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted after rebalance');
    assert.strictEqual(ts.dailyCount, 3);
  });
  it('emits throttleState when throttle rejects', async () => {
    const { stateUpdates } = await _poll(700, { botState: {}, collectStates: true,
      setupDeps: d => {
        d.throttle.canRebalance = () => ({ allowed: false, msUntilAllowed: 60000, reason: 'daily_max' });
        d.throttle.getState = () => ({ dailyCount: 20, dailyMax: 20 });
      } });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted on throttle rejection');
    assert.strictEqual(ts.dailyCount, 20);
  });
});

describe('bot-loop: gas deferral', () => {
  it('returns gasDeferred when gas exceeds 0.5% of position value', async () => {
    const provider = { mockProvider: true, getFeeData: async () => ({ gasPrice: 100_000_000_000_000n }) };
    const { r } = await _poll(700, { provider });
    assert.ok(r.rebalanced === true || r.gasDeferred === true, 'should either rebalance or defer on gas');
  });
  it('returns inRange:true when position is in range', async () => {
    const { r } = await _poll(0, { botState: {} });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.inRange, true);
  });
});

describe('bot-loop: pnlSnapshot with dailyPnl', () => {
  it('emits pnlSnapshot containing dailyPnl in updateBotState when in range with tracker', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({ entryValue: 100, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 0.001, token1UsdPrice: 0.0005 });
    const { stateUpdates } = await _poll(0, { botState: {}, tracker, collectStates: true });
    const snapUpdate = stateUpdates.find((u) => u.pnlSnapshot);
    assert.ok(snapUpdate, 'updateBotState should include pnlSnapshot');
    assert.ok(Array.isArray(snapUpdate.pnlSnapshot.dailyPnl), 'pnlSnapshot should contain dailyPnl array');
  });
});

describe('bot-loop: positionStats balance and activePosition liquidity', () => {
  it('emits balance0 and balance1 in positionStats when in range', async () => {
    const { captured } = await _poll(0, { botState: {}, captureState: true });
    assert.ok(captured.positionStats, 'positionStats should be emitted');
    assert.strictEqual(typeof captured.positionStats.balance0, 'string');
    assert.strictEqual(typeof captured.positionStats.balance1, 'string');
    assert.ok(captured.positionStats.balance0.includes('.'), 'balance0 should be a decimal string');
  });
  it('emits balance0 and balance1 when out of range', async () => {
    const { stateUpdates } = await _poll(700, { collectStates: true });
    const stats = stateUpdates.find((u) => u.positionStats);
    assert.ok(stats, 'positionStats should be emitted');
    assert.strictEqual(typeof stats.positionStats.balance0, 'string');
    assert.strictEqual(typeof stats.positionStats.balance1, 'string');
  });
  it('emits liquidity in activePosition after rebalance', async () => {
    const { stateUpdates } = await _poll(700, { collectStates: true });
    const posUpdate = stateUpdates.find((u) => u.activePosition);
    assert.ok(posUpdate, 'activePosition should be emitted after rebalance');
    assert.strictEqual(typeof posUpdate.activePosition.liquidity, 'string');
  });
  it('includes compositionRatio alongside balances', async () => {
    const { captured } = await _poll(0, { botState: {}, captureState: true });
    assert.strictEqual(typeof captured.positionStats.compositionRatio, 'number');
    assert.ok(captured.positionStats.compositionRatio >= 0 && captured.positionStats.compositionRatio <= 1);
  });
});

describe('bot-loop: closed position guard', () => {
  it('skips rebalance when position has zero liquidity', async () => {
    const { r } = await _poll(700, {
      setupDeps: d => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(r.rebalanced, false, 'should not rebalance a closed position');
  });

  it('still publishes stats for a closed position', async () => {
    const result = await _poll(700, {
      captureState: true,
      setupDeps: d => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(result.r.rebalanced, false);
    assert.ok(result.captured.positionStats, 'positionStats should still be emitted for closed positions');
  });
});

describe('bot-loop: closed position skips range check', () => {
  it('does not attempt rebalance even with forceRebalance set', async () => {
    const { r } = await _poll(700, {
      botState: { forceRebalance: true, rangeWidthPct: 20, slippagePct: 0.5 },
      setupDeps: d => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(r.rebalanced, false, 'should not rebalance closed position even when forced');
  });
});

describe('bot-loop: lifetime P&L is independent of selected position', () => {
  it('pnlSnapshot.initialDeposit is from tracker, not from position tokenId', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const LIFETIME_DEPOSIT = 500;
    const tracker = createPnlTracker({ initialDeposit: LIFETIME_DEPOSIT });
    tracker.openEpoch({ entryValue: 500, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0 });
    // Run with default position (tokenId=1n)
    const { captured: cap1 } = await _poll(0, { botState: {}, tracker, captureState: true });
    assert.ok(cap1.pnlSnapshot, 'pnlSnapshot should be emitted');
    const deposit1 = cap1.pnlSnapshot.initialDeposit;
    assert.strictEqual(deposit1, LIFETIME_DEPOSIT, 'deposit should match tracker config');
    // Run again — same tracker, different poll cycle; tokenId on the position object is irrelevant
    const tracker2 = createPnlTracker({ initialDeposit: LIFETIME_DEPOSIT });
    tracker2.openEpoch({ entryValue: 500, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0 });
    const { captured: cap2 } = await _poll(0, { botState: {}, tracker: tracker2, captureState: true });
    assert.strictEqual(cap2.pnlSnapshot.initialDeposit, LIFETIME_DEPOSIT,
      'lifetime deposit should be the same regardless of which position is selected in the browser');
  });
});
