"use strict";

/**
 * @file test/dashboard-ui-wake-staleness.test.js
 * @description Tests for the UI-wake staleness filter that suppresses
 *   polling-driven sound effects for events whose server-side timestamp
 *   predates the dashboard's most recent wake-from-idle transition.
 *
 *   Bug under test: during burn-in, users observed a backlog of
 *   rebalance / compound jingles play on returning to the desktop
 *   after hours away.  The existing `isBrowserPaused()` gate inside
 *   `playSound` covers the in-tab idle case (polling continues, the
 *   seen-maps absorb events silently while the flag is true), but it
 *   does not catch system-suspend or tab-discard.  When JS execution
 *   freezes, polling stops, the seen-maps never update, and on wake
 *   the next poll fires sounds for every event the bot recorded
 *   during sleep.
 *
 *   Fix: a new `_uiLastWokeUpAtMS` module state in
 *   `public/dashboard-idle.js` advances inside `_onActivity` when an
 *   activity event lands after a gap exceeding `PAUSE_AFTER_NO_INPUT_MS`
 *   (15 min).  `isStaleForUiPurposes(eventMs)` returns `true` when
 *   `eventMs < _uiLastWokeUpAtMS`.  In `public/dashboard-sounds.js`,
 *   `checkRebalanceSound` and `checkCompoundSound` consult that gate
 *   after the existing `_trackersPrimed` check and skip `playSound` for
 *   any event whose server timestamp predates the wake moment.
 *
 *   The dashboard modules are ES modules bundled by esbuild for the
 *   browser; this test replicates the relevant logic in CommonJS for
 *   direct test access — same pattern as `test/dashboard-idle.test.js`
 *   and `test/dashboard-sounds-idle-gate.test.js`.  Mirror is small
 *   enough to keep in lockstep by inspection — if you change one,
 *   change the other.
 *
 *   Source mirrored:
 *     - public/dashboard-idle.js (_uiLastWokeUpAtMS, _onActivity wake
 *       branch, isStaleForUiPurposes)
 *     - public/dashboard-sounds.js (_toMs, checkRebalanceSound,
 *       checkCompoundSound, _rebSeen, _compoundSeen, _trackersPrimed)
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/* ── Replica state ─────────────────────────────────────────────────── */

const PAUSE_AFTER_NO_INPUT_MS = 15 * 60_000;
const ACTIVITY_THROTTLE_MS = 500;

let _now = 0;
let _lastActivityTs = 0;
let _uiLastWokeUpAtMS = 0;

let _rebSeen;
let _compoundSeen;
let _trackersPrimed;
let _soundCalls;

function _resetReplicaState(initialNow) {
  _now = initialNow;
  _lastActivityTs = 0;
  _uiLastWokeUpAtMS = initialNow;
  _rebSeen = new Map();
  _compoundSeen = new Map();
  _trackersPrimed = false;
  _soundCalls = [];
}

/* ── Replica of dashboard-idle.js _onActivity wake-detection ───────── */

function _onActivity() {
  const now = _now;
  if (now - _lastActivityTs < ACTIVITY_THROTTLE_MS) return;
  if (now - _lastActivityTs > PAUSE_AFTER_NO_INPUT_MS) {
    _uiLastWokeUpAtMS = now;
  }
  _lastActivityTs = now;
}

function isStaleForUiPurposes(eventMs) {
  return eventMs < _uiLastWokeUpAtMS;
}

/* ── Replica of dashboard-sounds.js _toMs + sound gates ────────────── */

function _toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function _playSound(label) {
  _soundCalls.push(label);
}

function checkRebalanceSound(key, lastRebalanceAt) {
  if (!lastRebalanceAt || lastRebalanceAt === _rebSeen.get(key)) return;
  _rebSeen.set(key, lastRebalanceAt);
  if (!_trackersPrimed) return;
  const eventMs = _toMs(lastRebalanceAt);
  if (eventMs !== null && isStaleForUiPurposes(eventMs)) return;
  _playSound("rebalance");
}

function checkCompoundSound(key, lastCompoundAt) {
  if (!lastCompoundAt || lastCompoundAt === _compoundSeen.get(key)) return;
  _compoundSeen.set(key, lastCompoundAt);
  if (!_trackersPrimed) return;
  const eventMs = _toMs(lastCompoundAt);
  if (eventMs !== null && isStaleForUiPurposes(eventMs)) return;
  _playSound("compound");
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("isStaleForUiPurposes — boundary semantics", () => {
  beforeEach(() => {
    _resetReplicaState(1_000_000);
  });

  it("returns false when eventMs is strictly greater than _uiLastWokeUpAtMS", () => {
    _uiLastWokeUpAtMS = 1_000_000;
    assert.strictEqual(isStaleForUiPurposes(1_000_001), false);
  });

  it("returns true when eventMs is strictly less than _uiLastWokeUpAtMS", () => {
    _uiLastWokeUpAtMS = 1_000_000;
    assert.strictEqual(isStaleForUiPurposes(999_999), true);
  });

  it("returns false at exact equality (strict < not <=)", () => {
    _uiLastWokeUpAtMS = 1_000_000;
    assert.strictEqual(isStaleForUiPurposes(1_000_000), false);
  });
});

describe("_onActivity — wake-stamp advancement", () => {
  beforeEach(() => {
    _resetReplicaState(0);
    /*- Simulate a session that has been active for a while so the
     *  throttle is cleared and _lastActivityTs has a real value. */
    _now = 60_000;
    _lastActivityTs = 60_000;
    _uiLastWokeUpAtMS = 60_000;
  });

  it("activity after gap > 15 min advances _uiLastWokeUpAtMS to now", () => {
    _now = 60_000 + PAUSE_AFTER_NO_INPUT_MS + 1;
    _onActivity();
    assert.strictEqual(_uiLastWokeUpAtMS, _now);
  });

  it("activity with gap < 15 min does NOT advance _uiLastWokeUpAtMS", () => {
    _now = 60_000 + PAUSE_AFTER_NO_INPUT_MS - 1_000;
    _onActivity();
    assert.strictEqual(_uiLastWokeUpAtMS, 60_000);
  });

  it("activity with gap === 15 min exactly does NOT advance (strict >)", () => {
    _now = 60_000 + PAUSE_AFTER_NO_INPUT_MS;
    _onActivity();
    assert.strictEqual(_uiLastWokeUpAtMS, 60_000);
  });

  it("throttled rapid activity (< 500 ms apart) returns before the wake check", () => {
    _now = 60_000 + 200;
    _onActivity();
    assert.strictEqual(_uiLastWokeUpAtMS, 60_000);
    assert.strictEqual(
      _lastActivityTs,
      60_000,
      "throttled activity must NOT update _lastActivityTs either",
    );
  });

  it("subsequent activity within awake period does not re-advance the stamp", () => {
    _now = 60_000 + PAUSE_AFTER_NO_INPUT_MS + 1;
    _onActivity();
    const wakeFirst = _uiLastWokeUpAtMS;
    _now += 30_000;
    _onActivity();
    assert.strictEqual(_uiLastWokeUpAtMS, wakeFirst);
  });
});

describe("_toMs — input normalization", () => {
  it("numeric ms passes through unchanged", () => {
    assert.strictEqual(_toMs(1_778_521_251_000), 1_778_521_251_000);
  });

  it("ISO string parses to ms", () => {
    const iso = "2026-05-11T16:24:11.000Z";
    assert.strictEqual(_toMs(iso), Date.parse(iso));
  });

  it("unparseable string returns null", () => {
    assert.strictEqual(_toMs("not-a-date"), null);
  });

  it("NaN / Infinity return null", () => {
    assert.strictEqual(_toMs(NaN), null);
    assert.strictEqual(_toMs(Infinity), null);
  });

  it("undefined / null / non-string non-number return null", () => {
    assert.strictEqual(_toMs(undefined), null);
    assert.strictEqual(_toMs(null), null);
    assert.strictEqual(_toMs({}), null);
  });
});

describe("checkRebalanceSound / checkCompoundSound — staleness integration", () => {
  beforeEach(() => {
    _resetReplicaState(0);
    _uiLastWokeUpAtMS = 1_000_000;
    _trackersPrimed = true;
  });

  it("stale rebalance event (numeric ms before wake) is suppressed but seen-map updates", () => {
    const key = "pos-1";
    checkRebalanceSound(key, 999_000);
    assert.deepStrictEqual(_soundCalls, []);
    assert.strictEqual(_rebSeen.get(key), 999_000);
  });

  it("fresh rebalance event (numeric ms after wake) plays", () => {
    checkRebalanceSound("pos-1", 1_000_001);
    assert.deepStrictEqual(_soundCalls, ["rebalance"]);
  });

  it("stale compound event (ISO string before wake) is suppressed but seen-map updates", () => {
    const key = "pos-1";
    const isoBeforeWake = new Date(999_000).toISOString();
    checkCompoundSound(key, isoBeforeWake);
    assert.deepStrictEqual(_soundCalls, []);
    assert.strictEqual(_compoundSeen.get(key), isoBeforeWake);
  });

  it("fresh compound event (ISO string after wake) plays", () => {
    const isoAfterWake = new Date(1_000_001).toISOString();
    checkCompoundSound("pos-1", isoAfterWake);
    assert.deepStrictEqual(_soundCalls, ["compound"]);
  });

  it("not-primed-yet event is suppressed regardless of staleness (existing behavior preserved)", () => {
    _trackersPrimed = false;
    checkRebalanceSound("pos-1", 1_000_001);
    checkCompoundSound("pos-2", new Date(1_000_001).toISOString());
    assert.deepStrictEqual(_soundCalls, []);
    assert.strictEqual(_rebSeen.get("pos-1"), 1_000_001);
    assert.ok(_compoundSeen.get("pos-2"));
  });

  it("unparseable timestamp bypasses the staleness gate (fail-open)", () => {
    checkRebalanceSound("pos-1", "garbage-not-a-date");
    assert.deepStrictEqual(_soundCalls, ["rebalance"]);
  });

  it("repeated identical timestamp on subsequent polls does not re-fire (seen-map gate)", () => {
    checkRebalanceSound("pos-1", 1_000_001);
    checkRebalanceSound("pos-1", 1_000_001);
    checkRebalanceSound("pos-1", 1_000_001);
    assert.deepStrictEqual(_soundCalls, ["rebalance"]);
  });
});

describe("end-to-end — wake transition silences backlog then plays fresh events", () => {
  beforeEach(() => {
    _resetReplicaState(0);
    /*- Long-running active session up to t = 60_000. */
    _now = 60_000;
    _lastActivityTs = 60_000;
    _uiLastWokeUpAtMS = 60_000;
    _trackersPrimed = true;
  });

  it("wake activity advances stamp; backlog event from sleep is suppressed; post-wake event plays", () => {
    /*- Bot records a compound during the suspend window. */
    const compoundDuringSleep = 60_000 + 60 * 60_000;
    /*- ~3 hours of system suspend.  User unlocks. */
    _now = 60_000 + 3 * 60 * 60_000;
    _onActivity();
    assert.strictEqual(
      _uiLastWokeUpAtMS,
      _now,
      "wake stamp must advance on activity after long gap",
    );
    /*- First poll after wake surfaces the sleep-window compound. */
    checkCompoundSound("pos-A", new Date(compoundDuringSleep).toISOString());
    assert.deepStrictEqual(
      _soundCalls,
      [],
      "backlog compound must not play on wake",
    );
    /*- Bot fires a genuinely fresh compound moments after wake. */
    const freshAfterWake = _now + 5_000;
    checkCompoundSound("pos-A", new Date(freshAfterWake).toISOString());
    assert.deepStrictEqual(_soundCalls, ["compound"]);
  });
});
