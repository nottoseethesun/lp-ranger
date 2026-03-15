/**
 * @file test/optimizer-scheduler.test.js
 * @description Unit tests for src/optimizer-scheduler.js.
 * Uses controllable clocks and mock clients — no real HTTP or timers.
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { createOptimizerScheduler, DEFAULT_INTERVAL_MS, MAX_HISTORY } = require('../src/optimizer-scheduler');
const { applyRecommendation, defaultParams } = require('../src/optimizer-applicator');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock client that returns a controlled FetchResult. */
function mockClient(result) {
  return {
    fetchRecommendation: async () => result,
    ping: async () => ({ reachable: true, latencyMs: 1, error: null }),
  };
}

/** Build a mock client that throws. */
function throwingClient(message) {
  return {
    fetchRecommendation: async () => { throw new Error(message); },
    ping: async () => ({ reachable: false, latencyMs: 0, error: message }),
  };
}

const GOOD_RESULT = {
  ok: true,
  recommendation: { rangeWidthPct: 15, triggerType: 'oor', fetchedAt: new Date().toISOString() },
  error: null,
  httpStatus: 200,
};

const BAD_RESULT = {
  ok: false,
  recommendation: null,
  error: 'Engine unavailable',
  httpStatus: 503,
};

// ── Constructor validation ────────────────────────────────────────────────────

describe('createOptimizerScheduler — constructor', () => {
  it('throws when client is missing', () => {
    assert.throws(() => createOptimizerScheduler({}), /client/i);
  });

  it('throws when client lacks fetchRecommendation', () => {
    assert.throws(() => createOptimizerScheduler({ client: {} }), /fetchRecommendation/i);
  });

  it('creates a scheduler with a valid client', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    assert.ok(typeof s.enable   === 'function');
    assert.ok(typeof s.disable  === 'function');
    assert.ok(typeof s.toggle   === 'function');
    assert.ok(typeof s.queryNow === 'function');
    assert.ok(typeof s.getStatus=== 'function');
  });
});

// ── Initial state ─────────────────────────────────────────────────────────────

describe('createOptimizerScheduler — initial state', () => {
  it('starts disabled', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    assert.strictEqual(s.getStatus().enabled, false);
  });

  it('has zero fetches initially', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    const st = s.getStatus();
    assert.strictEqual(st.totalFetches,   0);
    assert.strictEqual(st.successFetches, 0);
  });

  it('has null lastFetchAt initially', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    assert.strictEqual(s.getStatus().lastFetchAt, null);
  });
});

// ── enable / disable / toggle ─────────────────────────────────────────────────

describe('createOptimizerScheduler — enable/disable', () => {
  it('enable() sets enabled:true', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT), intervalMs: 99999999 });
    s.enable();
    assert.strictEqual(s.getStatus().enabled, true);
    s.disable();
  });

  it('disable() sets enabled:false', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT), intervalMs: 99999999 });
    s.enable();
    s.disable();
    assert.strictEqual(s.getStatus().enabled, false);
  });

  it('enable() is idempotent', () => {
    const calls = [];
    const s = createOptimizerScheduler({
      client: mockClient(GOOD_RESULT),
      intervalMs: 99999999,
      onStateChange: (state) => calls.push(state.enabled),
    });
    s.enable();
    s.enable(); // second call should be no-op
    assert.strictEqual(calls.length, 1);
    s.disable();
  });

  it('disable() is idempotent', () => {
    const calls = [];
    const s = createOptimizerScheduler({
      client: mockClient(GOOD_RESULT),
      intervalMs: 99999999,
      onStateChange: (state) => calls.push(state.enabled),
    });
    s.disable();
    s.disable();
    assert.strictEqual(calls.length, 0); // never enabled so no state changes
  });

  it('toggle() flips enabled state', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT), intervalMs: 99999999 });
    assert.strictEqual(s.toggle(), true);  // was false → now true
    assert.strictEqual(s.toggle(), false); // was true  → now false
  });

  it('onStateChange is called with correct value on enable/disable', () => {
    const events = [];
    const s = createOptimizerScheduler({
      client: mockClient(GOOD_RESULT),
      intervalMs: 99999999,
      onStateChange: (e) => events.push(e.enabled),
    });
    s.enable();
    s.disable();
    assert.deepStrictEqual(events, [true, false]);
  });

  it('nextFetchAt is null when disabled', () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT), intervalMs: 99999999 });
    s.enable();
    s.disable();
    assert.strictEqual(s.getStatus().nextFetchAt, null);
  });
});

// ── queryNow ──────────────────────────────────────────────────────────────────

describe('createOptimizerScheduler — queryNow', () => {
  it('fires a fetch cycle immediately', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    await s.queryNow();
    assert.strictEqual(s.getStatus().totalFetches,   1);
    assert.strictEqual(s.getStatus().successFetches, 1);
  });

  it('works even when scheduler is disabled', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    assert.strictEqual(s.getStatus().enabled, false);
    await s.queryNow();
    assert.strictEqual(s.getStatus().totalFetches, 1);
  });

  it('calls onFetch callback with the FetchResult', async () => {
    const received = [];
    const s = createOptimizerScheduler({
      client:  mockClient(GOOD_RESULT),
      onFetch: r => received.push(r),
    });
    await s.queryNow();
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].ok, true);
  });

  it('calls onApply when applicator and params are provided', async () => {
    const applyResults = [];
    const params = defaultParams();
    const s = createOptimizerScheduler({
      client:     mockClient(GOOD_RESULT),
      applicator: { applyRecommendation },
      params,
      onApply:    r => applyResults.push(r),
    });
    await s.queryNow();
    assert.strictEqual(applyResults.length, 1);
    assert.ok('changes' in applyResults[0]);
  });

  it('updates params when applicator and params are provided', async () => {
    const params = defaultParams(); // rangeWidthPct = 20
    const s = createOptimizerScheduler({
      client:     mockClient(GOOD_RESULT), // recommends rangeWidthPct: 15
      applicator: { applyRecommendation },
      params,
    });
    await s.queryNow();
    assert.strictEqual(params.rangeWidthPct, 15);
  });

  it('increments totalFetches on each call', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    await s.queryNow();
    await s.queryNow();
    assert.strictEqual(s.getStatus().totalFetches, 2);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('createOptimizerScheduler — error handling', () => {
  it('increments totalFetches but not successFetches on fetch failure', async () => {
    const s = createOptimizerScheduler({ client: mockClient(BAD_RESULT) });
    await s.queryNow();
    const st = s.getStatus();
    assert.strictEqual(st.totalFetches,   1);
    assert.strictEqual(st.successFetches, 0);
  });

  it('sets lastFetchOk to false on failure', async () => {
    const s = createOptimizerScheduler({ client: mockClient(BAD_RESULT) });
    await s.queryNow();
    assert.strictEqual(s.getStatus().lastFetchOk, false);
  });

  it('records error message when fetch fails', async () => {
    const s = createOptimizerScheduler({ client: mockClient(BAD_RESULT) });
    await s.queryNow();
    assert.strictEqual(s.getStatus().lastError, 'Engine unavailable');
  });

  it('calls onError when fetch result is not ok', async () => {
    const errors = [];
    const s = createOptimizerScheduler({
      client:  mockClient(BAD_RESULT),
      onError: e => errors.push(e.message),
    });
    await s.queryNow();
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('Engine unavailable'));
  });

  it('calls onError when client throws', async () => {
    const errors = [];
    const s = createOptimizerScheduler({
      client:  throwingClient('network down'),
      onError: e => errors.push(e.message),
    });
    await s.queryNow();
    assert.ok(errors[0].includes('network down'));
  });

  it('does not crash when onError is not provided', async () => {
    const s = createOptimizerScheduler({ client: mockClient(BAD_RESULT) });
    await assert.doesNotReject(() => s.queryNow());
  });
});

// ── History ring buffer ────────────────────────────────────────────────────────

describe('createOptimizerScheduler — history', () => {
  it('records a history entry on each fetch', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    await s.queryNow();
    await s.queryNow();
    assert.strictEqual(s.getStatus().history.length, 2);
  });

  it('history entries include ok and fetchedAt', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    await s.queryNow();
    const entry = s.getStatus().history[0];
    assert.strictEqual(entry.ok, true);
    assert.ok(typeof entry.fetchedAt === 'string');
  });

  it('history is newest-first', async () => {
    let callIndex = 0;
    const client = {
      fetchRecommendation: async () => ({
        ok: true,
        recommendation: { rangeWidthPct: ++callIndex, fetchedAt: new Date().toISOString() },
        error: null, httpStatus: 200,
      }),
    };
    const s = createOptimizerScheduler({ client });
    await s.queryNow(); // rangeWidthPct = 1
    await s.queryNow(); // rangeWidthPct = 2
    const hist = s.getStatus().history;
    // Most recent (rangeWidthPct:2) should be first
    assert.strictEqual(hist[0].recommendation.rangeWidthPct, 2);
    assert.strictEqual(hist[1].recommendation.rangeWidthPct, 1);
  });

  it(`caps history at MAX_HISTORY (${MAX_HISTORY})`, async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      await s.queryNow();
    }
    assert.strictEqual(s.getStatus().history.length, MAX_HISTORY);
  });

  it('history in getStatus() is a copy — mutations do not affect internal state', async () => {
    const s = createOptimizerScheduler({ client: mockClient(GOOD_RESULT) });
    await s.queryNow();
    const hist = s.getStatus().history;
    hist.push({ fake: true });
    assert.strictEqual(s.getStatus().history.length, 1);
  });
});

// ── setRequest ────────────────────────────────────────────────────────────────

describe('createOptimizerScheduler — setRequest', () => {
  it('updates request sent to client', async () => {
    let lastRequest = null;
    const client = {
      fetchRecommendation: async (req) => {
        lastRequest = { ...req };
        return GOOD_RESULT;
      },
    };
    const s = createOptimizerScheduler({ client, request: { feeTier: 3000 } });
    s.setRequest({ feeTier: 500, poolAddress: '0xABC' });
    await s.queryNow();
    assert.strictEqual(lastRequest.feeTier,     500);
    assert.strictEqual(lastRequest.poolAddress, '0xABC');
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_INTERVAL_MS is 10 minutes', () => {
    assert.strictEqual(DEFAULT_INTERVAL_MS, 10 * 60 * 1000);
  });
  it('MAX_HISTORY is 50', () => {
    assert.strictEqual(MAX_HISTORY, 50);
  });
});
