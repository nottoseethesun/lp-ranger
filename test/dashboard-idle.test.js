"use strict";

/**
 * @file test/dashboard-idle.test.js
 * @description Tests for the no-input timer's staleness guard in
 *   `public/dashboard-idle.js`.  The prior file mirrored the whole
 *   arming path in CJS; this file drives the real `_isStaleFire`
 *   export directly under jsdom.  The pure staleness check
 *   (`nowMs - armedAt > 15 min + 2 s`) is the entire load-bearing
 *   logic of the guard — the surrounding setTimeout/closure plumbing
 *   is what routes the check, not what makes it correct.
 *
 *   Bug this guard prevents: after a long throttled-tab interval,
 *   Chrome can move a long-deferred setTimeout callback from the
 *   timer-heap into the task queue.  `clearTimeout` afterwards is a
 *   no-op for an already-queued task, so a fresh `_onActivity` reset
 *   arms a new timer correctly but moments later the stale callback
 *   flushes and pauses everything — the user-observed
 *   `unpaused (mousemove) → paused 10s later` race.  The closure
 *   captures `armedAt` per-arming, and the staleness check bails when
 *   the delivered callback is more than 2 s past its intended fire
 *   time.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const PAUSE_AFTER_NO_INPUT_MS = 15 * 60_000;
const STALE_MARGIN_MS = 2_000;

let mod;

before(async () => {
  mod = await import("../public/dashboard-idle.js");
});

describe("_isStaleFire()", () => {
  it("is false when the callback fires exactly at the intended time (delta = 0)", () => {
    const armedAt = 1_000_000;
    const nowMs = armedAt + PAUSE_AFTER_NO_INPUT_MS;
    assert.strictEqual(mod._isStaleFire(armedAt, nowMs), false);
  });

  it("is false when the callback fires up to STALE_MARGIN_MS late (Chrome jitter)", () => {
    const armedAt = 1_000_000;
    const nowMs = armedAt + PAUSE_AFTER_NO_INPUT_MS + STALE_MARGIN_MS;
    assert.strictEqual(mod._isStaleFire(armedAt, nowMs), false);
  });

  it("becomes true 1 ms past the STALE_MARGIN_MS margin (bug guard fires)", () => {
    const armedAt = 1_000_000;
    const nowMs = armedAt + PAUSE_AFTER_NO_INPUT_MS + STALE_MARGIN_MS + 1;
    assert.strictEqual(mod._isStaleFire(armedAt, nowMs), true);
  });

  it("is true for a callback delivered hours late (the real bug scenario)", () => {
    const armedAt = 1_000_000;
    const nowMs = armedAt + 3 * 60 * 60_000; // 3 hours
    assert.strictEqual(mod._isStaleFire(armedAt, nowMs), true);
  });

  it("is false when the callback fires slightly early — jitter can go both ways", () => {
    const armedAt = 1_000_000;
    // 14 min 55 s past arming — under the intended fire time.
    const nowMs = armedAt + PAUSE_AFTER_NO_INPUT_MS - 5_000;
    assert.strictEqual(mod._isStaleFire(armedAt, nowMs), false);
  });

  it("threshold is measured from ARMED (not from wall-clock 0) — closure semantics", () => {
    /*- Two independent armings at wildly different wall-clock times
     *  must each judge staleness relative to THEIR OWN armedAt.  This
     *  is what the closure capture buys — a module-level `_lastArmedAt`
     *  would be overwritten by the second arming and mis-classify the
     *  first callback's staleness. */
    const first = 1_000_000;
    const second = 500_000_000_000; // arbitrary distant future
    // First callback fires at intended time relative to first arming.
    assert.strictEqual(
      mod._isStaleFire(first, first + PAUSE_AFTER_NO_INPUT_MS),
      false,
    );
    // Second callback fires at intended time relative to second arming.
    assert.strictEqual(
      mod._isStaleFire(second, second + PAUSE_AFTER_NO_INPUT_MS),
      false,
    );
    // A STALE first callback delivered at the second arming's time
    // (hours after first) is judged against ITS armedAt (first) and
    // trips the guard.
    assert.strictEqual(
      mod._isStaleFire(first, second + PAUSE_AFTER_NO_INPUT_MS),
      true,
    );
  });
});

// ── isStaleForUiPurposes (public API) ─────────────────────────────────

describe("isStaleForUiPurposes()", () => {
  it("is a function exported by the real module", () => {
    assert.strictEqual(typeof mod.isStaleForUiPurposes, "function");
  });

  it("distinguishes events before/after the tracker's wake timestamp", () => {
    /*- `_uiLastWokeUpAtMS` initialises to Date.now() at module load.
     *  Anything before that is stale; anything at-or-after is not. */
    const now = Date.now();
    assert.strictEqual(mod.isStaleForUiPurposes(now - 60_000), true);
    assert.strictEqual(mod.isStaleForUiPurposes(now + 60_000), false);
  });
});

// ── isBrowserPaused (public API) ──────────────────────────────────────

describe("isBrowserPaused()", () => {
  it("returns the current _browserHasPaused flag", () => {
    // Initial state on module load is false — no pause has fired.
    assert.strictEqual(typeof mod.isBrowserPaused(), "boolean");
  });
});
