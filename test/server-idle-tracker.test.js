/**
 * @file test/server-idle-tracker.test.js
 * @description Clock-driven tests for the server-side idle tracker.
 *   Exercises onIdle firing once on threshold cross, markActivity
 *   resetting the countdown but NOT clearing the paused flag, and
 *   start/stop lifecycle.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createIdleTracker } = require("../src/server/server-idle-tracker");

/** Controllable clock — same shape as test/throttle.test.js makeClock. */
function makeClock(startMs = 0) {
  let now = startMs;
  return {
    tick: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
    fn: () => now,
  };
}

/**
 * Drive timer-based code with a fake clock.  The tracker uses a
 * self-rescheduling `setTimeout` chain; we replace setTimeout /
 * clearTimeout with a manual harness so the test controls when
 * `_check()` runs.  Each `tickAll()` call fires the *current
 * generation* of pending handles — callbacks that self-reschedule add
 * a new handle that won't fire until the next `tickAll()`.
 */
function withFakeTimeouts(testFn) {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let _pending = [];
  globalThis.setTimeout = (fn /*, _ms */) => {
    const handle = { fn, cleared: false, unref: () => {} };
    _pending.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };
  try {
    return testFn({
      tickAll: () => {
        const generation = _pending;
        _pending = [];
        for (const h of generation) if (!h.cleared) h.fn();
      },
      pendingCount: () => _pending.filter((h) => !h.cleared).length,
    });
  } finally {
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    _pending = [];
  }
}

let _tracker = null;
afterEach(() => {
  if (_tracker) _tracker.stop();
  _tracker = null;
});
beforeEach(() => {
  _tracker = null;
});

describe("createIdleTracker — input validation", () => {
  it("rejects non-positive thresholdMs", () => {
    assert.throws(() =>
      createIdleTracker({
        thresholdMs: 0,
        checkIntervalMs: 1000,
        onIdle: () => {},
      }),
    );
  });
  it("rejects non-positive checkIntervalMs", () => {
    assert.throws(() =>
      createIdleTracker({
        thresholdMs: 1000,
        checkIntervalMs: 0,
        onIdle: () => {},
      }),
    );
  });
  it("rejects non-function onIdle", () => {
    assert.throws(() =>
      createIdleTracker({
        thresholdMs: 1000,
        checkIntervalMs: 1000,
        onIdle: null,
      }),
    );
  });
});

describe("createIdleTracker — idle transition", () => {
  it("fires onIdle exactly once when threshold first crosses", () => {
    withFakeTimeouts(({ tickAll }) => {
      const clk = makeClock(1000);
      let calls = 0;
      _tracker = createIdleTracker({
        thresholdMs: 60_000,
        checkIntervalMs: 1000,
        onIdle: () => calls++,
        nowFn: clk.fn,
      });
      _tracker.start();
      tickAll(); // 0 elapsed → no fire
      assert.strictEqual(calls, 0);
      clk.tick(30_000);
      tickAll(); // 30 s elapsed → no fire
      assert.strictEqual(calls, 0);
      clk.tick(30_001);
      tickAll(); // 60.001 s elapsed → fire
      assert.strictEqual(calls, 1);
      tickAll(); // already paused, must not fire again
      tickAll();
      assert.strictEqual(calls, 1, "onIdle is one-shot per pause cycle");
    });
  });
});

describe("createIdleTracker — markActivity", () => {
  it("resets the idle countdown", () => {
    withFakeTimeouts(({ tickAll }) => {
      const clk = makeClock(1000);
      let calls = 0;
      _tracker = createIdleTracker({
        thresholdMs: 60_000,
        checkIntervalMs: 1000,
        onIdle: () => calls++,
        nowFn: clk.fn,
      });
      _tracker.start();
      clk.tick(45_000);
      _tracker.markActivity();
      clk.tick(45_000);
      tickAll(); // 45 s since last activity → no fire
      assert.strictEqual(calls, 0);
      clk.tick(20_000);
      tickAll(); // 65 s since last activity → fire
      assert.strictEqual(calls, 1);
    });
  });

  it("does NOT clear an existing paused flag", () => {
    /*- Critical invariant: ordinary /api/* traffic (which calls
     *  markActivity) must not unpause the gate.  Unpausing is always
     *  explicit (browser endpoint or move scope). */
    withFakeTimeouts(({ tickAll }) => {
      const clk = makeClock(1000);
      let calls = 0;
      _tracker = createIdleTracker({
        thresholdMs: 60_000,
        checkIntervalMs: 1000,
        onIdle: () => calls++,
        nowFn: clk.fn,
      });
      _tracker.start();
      clk.tick(70_000);
      tickAll(); // fire → paused = true
      assert.strictEqual(calls, 1);
      assert.strictEqual(_tracker.getState().paused, true);
      _tracker.markActivity();
      clk.tick(70_000);
      tickAll();
      assert.strictEqual(
        calls,
        1,
        "markActivity must not unpause and re-arm onIdle",
      );
      assert.strictEqual(_tracker.getState().paused, true);
    });
  });
});

describe("createIdleTracker — lifecycle", () => {
  it("start() is idempotent and stop() halts checks", () => {
    withFakeTimeouts(({ tickAll }) => {
      const clk = makeClock(1000);
      let calls = 0;
      _tracker = createIdleTracker({
        thresholdMs: 1000,
        checkIntervalMs: 100,
        onIdle: () => calls++,
        nowFn: clk.fn,
      });
      _tracker.start();
      _tracker.start(); // second start is a no-op
      assert.strictEqual(_tracker.getState().running, true);
      _tracker.stop();
      assert.strictEqual(_tracker.getState().running, false);
      clk.tick(10_000);
      tickAll(); // tracker was stopped — but our fake harness ignores
      // cleared handles, so this should still not fire onIdle
      assert.strictEqual(calls, 0);
    });
  });
});

describe("createIdleTracker — self-rescheduling chain", () => {
  it("each tick schedules the next setTimeout", () => {
    withFakeTimeouts(({ tickAll, pendingCount }) => {
      const clk = makeClock(1000);
      _tracker = createIdleTracker({
        thresholdMs: 60_000,
        checkIntervalMs: 1000,
        onIdle: () => {},
        nowFn: clk.fn,
      });
      _tracker.start();
      assert.strictEqual(pendingCount(), 1, "start() arms exactly one timer");
      tickAll();
      assert.strictEqual(
        pendingCount(),
        1,
        "first tick self-schedules the next",
      );
      tickAll();
      assert.strictEqual(
        pendingCount(),
        1,
        "subsequent ticks also self-schedule",
      );
      tickAll();
      assert.strictEqual(pendingCount(), 1, "chain continues indefinitely");
    });
  });

  it("stop() halts the chain mid-flight", () => {
    withFakeTimeouts(({ tickAll, pendingCount }) => {
      const clk = makeClock(1000);
      _tracker = createIdleTracker({
        thresholdMs: 60_000,
        checkIntervalMs: 1000,
        onIdle: () => {},
        nowFn: clk.fn,
      });
      _tracker.start();
      tickAll();
      assert.strictEqual(pendingCount(), 1);
      _tracker.stop();
      assert.strictEqual(
        pendingCount(),
        0,
        "stop() clears the pending timeout",
      );
      tickAll();
      assert.strictEqual(
        pendingCount(),
        0,
        "no further timeouts scheduled after stop()",
      );
    });
  });
});
