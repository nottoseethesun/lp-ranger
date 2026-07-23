"use strict";

/**
 * @file test/dashboard-ui-wake-staleness.test.js
 * @description Tests the pure decisions that back the UI-wake
 *   staleness filter for polling-driven event sounds.  The prior
 *   test file mirrored `_onActivity`, `_toMs`, and the sound-check
 *   flows in CJS; extracted decisions now let the tests drive the
 *   real module.
 *
 *   Exports under test:
 *     - `_shouldAdvanceWakeStamp(now, lastActivityTs)` — dashboard-idle
 *     - `isStaleForUiPurposes(eventMs)` — dashboard-idle (already public)
 *     - `_toMs(v)` — dashboard-sounds
 *     - `_shouldFireEventSound(eventAt, seenAt, trackersPrimed, isStale)`
 *       — dashboard-sounds
 *
 *   Bug the wake stamp + gate prevent: users observed a backlog of
 *   rebalance / compound jingles play on returning to the desktop
 *   after hours away.  The `isBrowserPaused()` gate inside `playSound`
 *   covers the in-tab idle case but not system-suspend / tab-discard.
 *   `_uiLastWokeUpAtMS` advances inside `_onActivity` when an activity
 *   event lands after a gap exceeding `PAUSE_AFTER_NO_INPUT_MS` (15 min);
 *   `isStaleForUiPurposes(eventMs)` returns true when
 *   `eventMs < _uiLastWokeUpAtMS`; `_shouldFireEventSound` uses that
 *   filter to suppress the sound for any event whose server timestamp
 *   predates the wake moment.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const PAUSE_AFTER_NO_INPUT_MS = 15 * 60_000;

let idle;
let sounds;

before(async () => {
  idle = await import("../public/dashboard-idle.js");
  sounds = await import("../public/dashboard-sounds.js");
});

// ── _shouldAdvanceWakeStamp ────────────────────────────────────────────

describe("_shouldAdvanceWakeStamp()", () => {
  it("advances when the gap exceeds PAUSE_AFTER_NO_INPUT_MS (15 min)", () => {
    const lastActivityTs = 1_000_000;
    const now = lastActivityTs + PAUSE_AFTER_NO_INPUT_MS + 1;
    assert.strictEqual(idle._shouldAdvanceWakeStamp(now, lastActivityTs), true);
  });

  it("does NOT advance when the gap is under the threshold", () => {
    const lastActivityTs = 1_000_000;
    const now = lastActivityTs + PAUSE_AFTER_NO_INPUT_MS - 1_000;
    assert.strictEqual(
      idle._shouldAdvanceWakeStamp(now, lastActivityTs),
      false,
    );
  });

  it("does NOT advance at exact equality (strict > not >=)", () => {
    /*- The wake stamp advances only on genuine sleep windows —
     *  exactly 15 min is the boundary, not the trigger. */
    const lastActivityTs = 1_000_000;
    const now = lastActivityTs + PAUSE_AFTER_NO_INPUT_MS;
    assert.strictEqual(
      idle._shouldAdvanceWakeStamp(now, lastActivityTs),
      false,
    );
  });

  it("handles fresh session (lastActivityTs = 0)", () => {
    /*- On very first activity ever, lastActivityTs is 0.  Any `now`
     *  beyond the threshold counts as a wake-from-idle. */
    assert.strictEqual(
      idle._shouldAdvanceWakeStamp(PAUSE_AFTER_NO_INPUT_MS + 1, 0),
      true,
    );
  });
});

// ── isStaleForUiPurposes (public API, already tested for existence in idle) ──

describe("isStaleForUiPurposes() — boundary semantics", () => {
  /*- The module's `_uiLastWokeUpAtMS` initializes to Date.now() at
   *  module load.  These tests just verify the strict-<-not-<= contract
   *  against that initial value. */
  it("returns false when eventMs is strictly greater than the wake stamp", () => {
    const now = Date.now();
    // `now + 60_000` is strictly greater than the module's wake stamp
    // (which was Date.now() at module load, well before this line).
    assert.strictEqual(idle.isStaleForUiPurposes(now + 60_000), false);
  });

  it("returns true when eventMs predates the wake stamp", () => {
    // Zero definitely predates the module's wake stamp.
    assert.strictEqual(idle.isStaleForUiPurposes(0), true);
  });
});

// ── _toMs ──────────────────────────────────────────────────────────────

describe("_toMs()", () => {
  it("numeric ms passes through unchanged", () => {
    assert.strictEqual(sounds._toMs(1_778_521_251_000), 1_778_521_251_000);
  });

  it("ISO string parses to ms", () => {
    const iso = "2026-05-11T16:24:11.000Z";
    assert.strictEqual(sounds._toMs(iso), Date.parse(iso));
  });

  it("unparseable string returns null", () => {
    assert.strictEqual(sounds._toMs("not-a-date"), null);
  });

  it("NaN / Infinity return null", () => {
    assert.strictEqual(sounds._toMs(NaN), null);
    assert.strictEqual(sounds._toMs(Infinity), null);
  });

  it("undefined / null / non-string non-number return null", () => {
    assert.strictEqual(sounds._toMs(undefined), null);
    assert.strictEqual(sounds._toMs(null), null);
    assert.strictEqual(sounds._toMs({}), null);
  });
});

// ── _shouldFireEventSound ──────────────────────────────────────────────

describe("_shouldFireEventSound()", () => {
  const _at = "2026-05-11T16:24:11.000Z";
  const _prev = "2026-05-11T15:00:00.000Z";

  it("fires when event is new, trackers primed, and not stale", () => {
    assert.strictEqual(
      sounds._shouldFireEventSound(_at, _prev, true, false),
      true,
    );
  });

  it("does NOT fire when eventAt is missing (no signal)", () => {
    assert.strictEqual(
      sounds._shouldFireEventSound(null, _prev, true, false),
      false,
    );
    assert.strictEqual(
      sounds._shouldFireEventSound("", _prev, true, false),
      false,
    );
    assert.strictEqual(
      sounds._shouldFireEventSound(undefined, _prev, true, false),
      false,
    );
  });

  it("does NOT fire when eventAt matches seenAt (no change since last poll)", () => {
    assert.strictEqual(
      sounds._shouldFireEventSound(_at, _at, true, false),
      false,
    );
  });

  it("does NOT fire before trackers are primed (first-poll silence)", () => {
    /*- The first poll after load / wallet-switch primes the seen-maps
     *  without firing sounds — otherwise every existing event would
     *  play at once. */
    assert.strictEqual(
      sounds._shouldFireEventSound(_at, _prev, false, false),
      false,
    );
  });

  it(
    "does NOT fire when the event is stale (predates UI wake) — this is the " +
      "backlog-suppression bug fix",
    () => {
      assert.strictEqual(
        sounds._shouldFireEventSound(_at, _prev, true, true),
        false,
      );
    },
  );

  it("stale check beats primed check (both gates evaluated)", () => {
    /*- Even when trackers are primed, a stale event still bails.  The
     *  ordering doesn't matter for the outcome — both must be true for
     *  a fire — but pinning that the guard is on the RIGHT logical
     *  branch of the AND prevents a future refactor from collapsing
     *  them incorrectly. */
    assert.strictEqual(
      sounds._shouldFireEventSound(_at, _prev, true, true),
      false,
    );
    assert.strictEqual(
      sounds._shouldFireEventSound(_at, _prev, false, true),
      false,
    );
  });
});
