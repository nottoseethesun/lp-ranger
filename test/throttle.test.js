/**
 * @file test/throttle.test.js
 * @description Unit tests for the throttle module.
 * Run with: npm test
 */

'use strict';
const { describe, it } = require('node:test');

const assert = require('assert');
const { createThrottle, nextMidnight } = require('../src/throttle');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a controllable clock. */
function makeClock(startMs = 0) {
  let now = startMs;
  return {
    tick: (ms) => { now += ms; },
    set:  (ms) => { now  = ms; },
    fn:   () => now,
  };
}

const MIN = 60_000; // 1 minute in ms

// ── nextMidnight ─────────────────────────────────────────────────────────────

describe('nextMidnight', () => {
  it('returns a timestamp after the given time', () => {
    const now = Date.now();
    const nm  = nextMidnight(() => now);
    assert.ok(nm > now, 'nextMidnight should be after now');
  });

  it('returns at most 48 h in the future', () => {
    const now = Date.now();
    const nm  = nextMidnight(() => now);
    assert.ok(nm - now <= 48 * 3600 * 1000);
  });
});

// ── createThrottle — initial state ───────────────────────────────────────────

describe('createThrottle — initial state', () => {
  it('allows rebalance immediately (no prior rebalance)', () => {
    const t   = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: () => 1000 });
    const res = t.canRebalance();
    assert.strictEqual(res.allowed,  true);
    assert.strictEqual(res.reason,   'ok');
    assert.strictEqual(res.msUntilAllowed, 0);
  });

  it('reports correct initial dailyMax and minInterval in state', () => {
    const t = createThrottle({ minIntervalMs: 15 * MIN, dailyMax: 5, nowFn: () => 1000 });
    const s = t.getState();
    assert.strictEqual(s.minIntervalMs, 15 * MIN);
    assert.strictEqual(s.dailyMax,      5);
    assert.strictEqual(s.dailyCount,    0);
    assert.strictEqual(s.doublingActive, false);
  });
});

// ── minimum interval enforcement ─────────────────────────────────────────────

describe('createThrottle — minimum interval', () => {
  it('blocks rebalance within minInterval after recording one', () => {
    const clock = makeClock(Date.now()); // non-zero so lastRebTime > 0 guard fires
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance();
    clock.tick(5 * MIN); // only 5 min elapsed, need 10

    const res = t.canRebalance();
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason,  'min_interval');
    assert.ok(res.msUntilAllowed > 0);
  });

  it('allows rebalance exactly at minInterval boundary', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance();
    clock.tick(10 * MIN); // exactly at boundary

    assert.strictEqual(t.canRebalance().allowed, true);
  });

  it('allows rebalance after minInterval has elapsed', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance();
    clock.tick(11 * MIN);

    assert.strictEqual(t.canRebalance().allowed, true);
  });
});

// ── daily limit ──────────────────────────────────────────────────────────────

describe('createThrottle — daily limit', () => {
  it('blocks after dailyMax rebalances', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: MIN, dailyMax: 3, nowFn: clock.fn });

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(t.canRebalance().allowed, true, `should allow rebalance ${i + 1}`);
      t.recordRebalance();
      clock.tick(2 * MIN);
    }

    const res = t.canRebalance();
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason,  'daily_limit');
  });

  it('daily_limit takes precedence over min_interval', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 1, nowFn: clock.fn });

    t.recordRebalance();
    clock.tick(1 * MIN); // within minInterval AND at daily limit

    const res = t.canRebalance();
    assert.strictEqual(res.reason, 'daily_limit');
  });
});

// ── daily reset ──────────────────────────────────────────────────────────────

describe('createThrottle — daily reset', () => {
  it('resets dailyCount and doublingActive after midnight', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: MIN, dailyMax: 3, nowFn: clock.fn });

    t.recordRebalance(); t.recordRebalance(); t.recordRebalance();
    assert.strictEqual(t.canRebalance().allowed, false);

    // Advance past the daily reset time
    clock.set(t.getState().dailyResetAt + 1000);
    const { didReset } = t.tick();

    assert.strictEqual(didReset, true);
    assert.strictEqual(t.getState().dailyCount, 0);
    assert.strictEqual(t.canRebalance().allowed, true);
  });
});

// ── rehydrate ────────────────────────────────────────────────────────────────

describe('createThrottle — rehydrate', () => {
  it('seeds dailyCount from historical events', () => {
    const t = createThrottle({ minIntervalMs: MIN, dailyMax: 5 });
    assert.strictEqual(t.getState().dailyCount, 0);
    t.rehydrate(3);
    assert.strictEqual(t.getState().dailyCount, 3);
  });

  it('enforces daily limit after rehydration', () => {
    const t = createThrottle({ minIntervalMs: MIN, dailyMax: 5 });
    t.rehydrate(5);
    const res = t.canRebalance();
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'daily_limit');
  });

  it('allows rebalance when rehydrated count is below limit', () => {
    const t = createThrottle({ minIntervalMs: MIN, dailyMax: 5 });
    t.rehydrate(2);
    assert.strictEqual(t.canRebalance().allowed, true);
    assert.strictEqual(t.getState().dailyCount, 2);
  });
});

// ── doubling mode activation ──────────────────────────────────────────────────

describe('createThrottle — doubling mode', () => {
  it('activates doubling after 3 rebalances within 4× minInterval', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });
    // window = 4 × 10min = 40min; 3 rebalances at 11-min spacing = 22min total → inside window

    // 3 rebalances inside the 40-min window (spacing: 11 min each)
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    const { newlyDoubled } = t.recordRebalance();

    assert.strictEqual(newlyDoubled, true);
    const s = t.getState();
    assert.strictEqual(s.doublingActive, true);
    assert.strictEqual(s.doublingCount,  1);
    assert.strictEqual(s.currentWaitMs,  20 * MIN);
  });

  it('does NOT activate doubling if 3 rebalances span more than 4× minInterval', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    // Spaced 25 min apart — 3 total but spanning 50 min > 40 min window
    t.recordRebalance(); clock.tick(25 * MIN);
    t.recordRebalance(); clock.tick(25 * MIN);
    const { newlyDoubled } = t.recordRebalance();

    assert.strictEqual(newlyDoubled,              false);
    assert.strictEqual(t.getState().doublingActive, false);
  });

  it('doubles the wait on each subsequent rebalance in doubling mode', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    // Trigger doubling
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); // activates doubling → wait = 20m

    clock.tick(20 * MIN); // exactly at new wait
    assert.strictEqual(t.canRebalance().allowed, true);

    t.recordRebalance(); // second doubling → wait = 40m
    assert.strictEqual(t.getState().currentWaitMs, 40 * MIN);

    clock.tick(20 * MIN); // only 20m elapsed, need 40m
    assert.strictEqual(t.canRebalance().reason, 'doubling');
  });

  it('reports doubling reason when blocked', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); // activates doubling
    clock.tick(5 * MIN);

    const res = t.canRebalance();
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason,  'doubling');
  });
});

// ── doubling expiry ───────────────────────────────────────────────────────────

describe('createThrottle — doubling expiry', () => {
  it('clears doubling mode after 4× currentWait quiet period', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    // Activate doubling (currentWaitMs = 20m)
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance();

    // Advance by 4× the doubled wait (4 × 20m = 80m) without another rebalance
    clock.tick(81 * MIN);
    const { didClearDoubling } = t.tick();

    assert.strictEqual(didClearDoubling,          true);
    assert.strictEqual(t.getState().doublingActive, false);
    assert.strictEqual(t.getState().currentWaitMs, 10 * MIN); // reset to base
  });

  it('does NOT clear doubling mode before the expiry window', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance();

    clock.tick(79 * MIN); // just before 80m expiry
    t.tick();

    assert.strictEqual(t.getState().doublingActive, true);
  });
});

// ── midnight also clears doubling ─────────────────────────────────────────────

describe('createThrottle — midnight clears doubling', () => {
  it('midnight reset clears doubling mode', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    // Activate doubling
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance();
    assert.strictEqual(t.getState().doublingActive, true);

    // Advance past midnight reset
    clock.set(t.getState().dailyResetAt + 1000);
    t.tick();

    assert.strictEqual(t.getState().doublingActive, false);
    assert.strictEqual(t.getState().doublingCount, 0);
    assert.strictEqual(t.getState().currentWaitMs, 10 * MIN);
  });
});

// ── configure ────────────────────────────────────────────────────────────────

describe('createThrottle — configure', () => {
  it('updates minIntervalMs and currentWaitMs when not in doubling mode', () => {
    const t = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: () => 0 });
    t.configure({ minIntervalMs: 5 * MIN });
    const s = t.getState();
    assert.strictEqual(s.minIntervalMs,  5 * MIN);
    assert.strictEqual(s.currentWaitMs,  5 * MIN);
  });

  it('updates dailyMax without affecting currentWaitMs', () => {
    const t = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: () => 0 });
    t.configure({ dailyMax: 5 });
    assert.strictEqual(t.getState().dailyMax, 5);
    assert.strictEqual(t.getState().currentWaitMs, 10 * MIN);
  });

  it('does NOT update currentWaitMs when in doubling mode', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: clock.fn });

    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); clock.tick(11 * MIN);
    t.recordRebalance(); // activates doubling → currentWaitMs = 20m

    t.configure({ minIntervalMs: 5 * MIN }); // change base, but doubling is active
    assert.strictEqual(t.getState().currentWaitMs, 20 * MIN); // unchanged
  });
});

// ── getState immutability ─────────────────────────────────────────────────────

describe('createThrottle — getState snapshot', () => {
  it('returns a copy — mutations do not affect internal state', () => {
    const t = createThrottle({ minIntervalMs: 10 * MIN, dailyMax: 20, nowFn: () => 0 });
    const s = t.getState();
    s.dailyMax = 999;
    assert.notStrictEqual(t.getState().dailyMax, 999);
  });

  it('rebTimestamps in snapshot is a copy', () => {
    const clock = makeClock(0);
    const t     = createThrottle({ minIntervalMs: MIN, dailyMax: 20, nowFn: clock.fn });
    t.recordRebalance();
    const snap = t.getState();
    snap.rebTimestamps.push(999999);
    assert.strictEqual(t.getState().rebTimestamps.length, 1);
  });
});
