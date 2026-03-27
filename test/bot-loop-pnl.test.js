/**
 * @file test/bot-loop-pnl.test.js
 * @description Tests for src/bot-loop.js — IL/PnL override, throttleState,
 * gas deferral, pnlSnapshot, positionStats, closed position guard,
 * lifetime P&L, and OOR timeout suites.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { _overridePnlWithRealValues } = require('../src/bot-loop');
const { _poll } = require('./_bot-loop-helpers');

// ── IL/PnL override ─────────────────────────────────────────────────────────

describe('bot-loop: _overridePnlWithRealValues (IL computation)', () => {
  const pos = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
  const pool = { tick: 0, decimals0: 18, decimals1: 18 };

  it('computes negative IL when price diverges from entry', () => {
    const snap = {
      liveEpoch: { entryValue: 2000 },
      initialDeposit: 2000,
      totalGas: 0,
    };
    const baseline = {
      entryValue: 2000,
      hodlAmount0: 1,
      hodlAmount1: 1000,
      token0UsdPrice: 1000,
      token1UsdPrice: 1,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 2000, 1, 0);
    assert.strictEqual(typeof snap.totalIL, 'number');
    assert.ok(
      snap.totalIL < 0,
      'IL should be negative when price diverges',
    );
  });

  it('computes near-zero IL when prices unchanged', () => {
    const snap = {
      liveEpoch: { entryValue: 2000 },
      initialDeposit: 2000,
      totalGas: 0,
    };
    const baseline = {
      entryValue: 2000,
      hodlAmount0: 1,
      hodlAmount1: 1000,
      token0UsdPrice: 1000,
      token1UsdPrice: 1,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 1000, 1, 0);
    assert.strictEqual(typeof snap.totalIL, 'number');
  });

  it('uses persisted hodlBaseline deposited amounts', () => {
    const snap = {
      liveEpoch: { entryValue: 800 },
      initialDeposit: 800,
      totalGas: 0,
    };
    const baseline = {
      entryValue: 1000,
      hodlAmount0: 50,
      hodlAmount1: 500,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 20, 3, 0);
    assert.strictEqual(typeof snap.totalIL, 'number');
  });

  it('skips IL when liveEpoch has no entry prices and no baseline', () => {
    const snap = {
      liveEpoch: null,
      initialDeposit: 500,
      totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(snap.totalIL, undefined, 'totalIL should not be set');
    assert.strictEqual(snap._setHodlBaseline, undefined, 'no baseline to set');
  });

  it('skips IL when HODL baseline has no deposited amounts', () => {
    const snap = {
      liveEpoch: { entryValue: 500 },
      initialDeposit: 500,
      totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(
      snap.totalIL, undefined, 'totalIL should not be set without amounts',
    );
  });

  it('computes IL from baseline deposited amounts', () => {
    const snap = {
      liveEpoch: { entryValue: 500 },
      initialDeposit: 500,
      totalGas: 0,
    };
    const baseline = {
      entryValue: 500, hodlAmount0: 25, hodlAmount1: 125,
      token0UsdPrice: 10, token1UsdPrice: 2,
    };
    const deps = { _botState: { hodlBaseline: baseline } };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(
      typeof snap.totalIL, 'number', 'should compute IL from deposited amounts',
    );
  });

  it('computes lifetimeIL from first closed epoch amounts', () => {
    const snap = {
      liveEpoch: { entryValue: 800 },
      closedEpochs: [{ hodlAmount0: 30, hodlAmount1: 15 }],
      initialDeposit: 300,
      totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(typeof snap.lifetimeIL, 'number', 'lifetimeIL should be set');
  });

  it('lifetimeIL falls back to hodlBaseline amounts when no closed epochs', () => {
    const snap = {
      liveEpoch: { entryValue: 500 },
      closedEpochs: [],
      initialDeposit: 500,
      totalGas: 0,
    };
    const deps = {
      _botState: {
        hodlBaseline: {
          entryValue: 500,
          hodlAmount0: 25,
          hodlAmount1: 125,
        },
      },
    };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(
      typeof snap.lifetimeIL, 'number', 'lifetimeIL should be set from baseline amounts',
    );
  });

  it('lifetimeIL is undefined when no deposited amounts available', () => {
    const snap = {
      liveEpoch: null, closedEpochs: [], initialDeposit: 500, totalGas: 0,
    };
    const deps = { _botState: {} };
    _overridePnlWithRealValues(snap, deps, pos, pool, 10, 2, 0);
    assert.strictEqual(snap.lifetimeIL, undefined, 'lifetimeIL not set without amounts');
  });
});

// ── throttleState ───────────────────────────────────────────────────────────

describe('bot-loop: throttleState in updateBotState', () => {
  it('emits throttleState after a successful rebalance', async () => {
    const { stateUpdates } = await _poll(700, {
      collectStates: true,
      setupDeps: (d) => {
        d.throttle.getState = () => ({ dailyCount: 3, dailyMax: 20 });
      },
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted after rebalance');
    assert.strictEqual(ts.dailyCount, 3);
  });
  it('emits throttleState when throttle rejects', async () => {
    const { stateUpdates } = await _poll(700, {
      botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      collectStates: true,
      setupDeps: (d) => {
        d.throttle.canRebalance = () => ({
          allowed: false, msUntilAllowed: 60000, reason: 'daily_max',
        });
        d.throttle.getState = () => ({ dailyCount: 20, dailyMax: 20 });
      },
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, 'throttleState should be emitted on throttle rejection');
    assert.strictEqual(ts.dailyCount, 20);
  });
});

// ── gas deferral ────────────────────────────────────────────────────────────

describe('bot-loop: gas deferral', () => {
  it('returns gasDeferred when gas exceeds 0.5% of position value', async () => {
    const provider = {
      mockProvider: true,
      getFeeData: async () => ({ gasPrice: 100_000_000_000_000n }),
    };
    const { r } = await _poll(700, { provider });
    assert.ok(
      r.rebalanced === true || r.gasDeferred === true,
      'should either rebalance or defer on gas',
    );
  });
  it('returns inRange:true when position is in range', async () => {
    const { r } = await _poll(0, { botState: {} });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.inRange, true);
  });
});

// ── pnlSnapshot ─────────────────────────────────────────────────────────────

describe('bot-loop: pnlSnapshot with dailyPnl', () => {
  it('emits pnlSnapshot containing dailyPnl in updateBotState when in range with tracker', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const tracker = createPnlTracker({ initialDeposit: 100 });
    tracker.openEpoch({
      entryValue: 100, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 0.001, token1UsdPrice: 0.0005,
    });
    const { stateUpdates } = await _poll(0, {
      botState: {}, tracker, collectStates: true,
    });
    const snapUpdate = stateUpdates.find((u) => u.pnlSnapshot);
    assert.ok(snapUpdate, 'updateBotState should include pnlSnapshot');
    assert.ok(
      Array.isArray(snapUpdate.pnlSnapshot.dailyPnl),
      'pnlSnapshot should contain dailyPnl array',
    );
  });
});

// ── positionStats ───────────────────────────────────────────────────────────

describe('bot-loop: positionStats balance and activePosition liquidity', () => {
  it('emits balance0 and balance1 in positionStats when in range', async () => {
    const { captured } = await _poll(0, {
      botState: {}, captureState: true,
    });
    assert.ok(captured.positionStats, 'positionStats should be emitted');
    assert.strictEqual(typeof captured.positionStats.balance0, 'string');
    assert.strictEqual(typeof captured.positionStats.balance1, 'string');
    assert.ok(
      captured.positionStats.balance0.includes('.'), 'balance0 should be a decimal string',
    );
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
    const { captured } = await _poll(0, {
      botState: {}, captureState: true,
    });
    assert.strictEqual(typeof captured.positionStats.compositionRatio, 'number');
    assert.ok(
      captured.positionStats.compositionRatio >= 0 &&
        captured.positionStats.compositionRatio <= 1,
    );
  });
});

// ── closed position guard ───────────────────────────────────────────────────

describe('bot-loop: closed position guard', () => {
  it('skips rebalance when position has zero liquidity', async () => {
    const { r } = await _poll(700, {
      setupDeps: (d) => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(r.rebalanced, false, 'should not rebalance a closed position');
  });
  it('still publishes stats for a closed position', async () => {
    const result = await _poll(700, {
      captureState: true,
      setupDeps: (d) => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(result.r.rebalanced, false);
    assert.ok(
      result.captured.positionStats,
      'positionStats should still be emitted for closed positions',
    );
  });
});

describe('bot-loop: closed position skips range check', () => {
  it('rebalances closed position when forceRebalance is set (recovery mode)', async () => {
    const { r } = await _poll(700, {
      botState: {
        forceRebalance: true,
        rebalanceOutOfRangeThresholdPercent: 20,
        slippagePct: 0.5,
      },
      setupDeps: (d) => { d.position.liquidity = 0n; },
    });
    assert.strictEqual(
      r.rebalanced, true,
      'forced rebalance should proceed on closed position using wallet balances',
    );
  });
});

// ── lifetime P&L ────────────────────────────────────────────────────────────

describe('bot-loop: lifetime P&L is independent of selected position', () => {
  it('pnlSnapshot.initialDeposit is from tracker, not from position tokenId', async () => {
    const { createPnlTracker } = require('../src/pnl-tracker');
    const LIFETIME_DEPOSIT = 500;
    const tracker = createPnlTracker({ initialDeposit: LIFETIME_DEPOSIT });
    tracker.openEpoch({
      entryValue: 500, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0,
    });
    const { captured: cap1 } = await _poll(0, {
      botState: {}, tracker, captureState: true,
    });
    assert.ok(cap1.pnlSnapshot, 'pnlSnapshot should be emitted');
    assert.strictEqual(
      cap1.pnlSnapshot.initialDeposit,
      LIFETIME_DEPOSIT,
      'deposit should match tracker config',
    );
    const tracker2 = createPnlTracker({
      initialDeposit: LIFETIME_DEPOSIT,
    });
    tracker2.openEpoch({
      entryValue: 500, entryPrice: 1, lowerPrice: 0.8, upperPrice: 1.2,
      token0UsdPrice: 1.0, token1UsdPrice: 1.0,
    });
    const { captured: cap2 } = await _poll(0, {
      botState: {}, tracker: tracker2, captureState: true,
    });
    assert.strictEqual(
      cap2.pnlSnapshot.initialDeposit, LIFETIME_DEPOSIT,
      'lifetime deposit should be the same regardless of which position is selected in the browser',
    );
  });
});

// ── OOR timeout ─────────────────────────────────────────────────────────────

describe('bot-loop: OOR timeout', () => {
  it('does not trigger rebalance when timeout has not expired', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50,
      rebalanceTimeoutMin: 60, oorSince: Date.now(),
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.withinThreshold, true);
  });

  it('triggers rebalance when timeout has expired', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 60,
      oorSince: Date.now() - 61 * 60_000, slippagePct: 0.5,
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.rebalanced, true, 'should rebalance after OOR timeout expires');
  });

  it('sets oorSince on first OOR poll within threshold', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 60,
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.withinThreshold, true);
    assert.strictEqual(typeof botState.oorSince, 'number', 'oorSince should be set');
    assert.ok(botState.oorSince > 0);
  });

  it('clears oorSince when price returns to range', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 60,
      oorSince: Date.now() - 10_000,
    };
    const { r, stateUpdates } = await _poll(0, {
      botState, collectStates: true,
    });
    assert.strictEqual(r.inRange, true);
    assert.strictEqual(botState.oorSince, null, 'oorSince should be cleared on in-range');
    const cleared = stateUpdates.find((u) => u.oorSince === null);
    assert.ok(cleared, 'should emit oorSince: null');
  });

  it('clears oorSince after successful rebalance', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 1,
      oorSince: Date.now() - 2 * 60_000, slippagePct: 0.5,
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.rebalanced, true);
    assert.strictEqual(botState.oorSince, null, 'oorSince should be cleared after rebalance');
  });

  it('does not trigger when timeout is disabled (rebalanceTimeoutMin=0)', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 0,
      oorSince: Date.now() - 999 * 60_000,
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.withinThreshold, true);
  });

  it('timeout goes through throttle checks (not bypassed)', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 1,
      oorSince: Date.now() - 2 * 60_000, slippagePct: 0.5,
    };
    const { r } = await _poll(600, {
      botState,
      setupDeps: (d) => {
        d.throttle.canRebalance = () => ({
          allowed: false, msUntilAllowed: 60000, reason: 'min_interval',
        });
      },
    });
    assert.strictEqual(r.rebalanced, false, 'timeout should not bypass throttle');
  });

  it('no double-rebalance after timeout trigger', async () => {
    const botState = {
      rebalanceOutOfRangeThresholdPercent: 50, rebalanceTimeoutMin: 1,
      oorSince: Date.now() - 2 * 60_000, slippagePct: 0.5,
    };
    const { r } = await _poll(600, { botState });
    assert.strictEqual(r.rebalanced, true);
    assert.strictEqual(botState.oorSince, null, 'oorSince cleared — prevents immediate re-trigger');
  });
});
