"use strict";

/**
 * @file test/dashboard-sounds-idle-gate.test.js
 * @description Tests for the idle-gating logic in
 *   `public/dashboard-sounds.js` `playSound()`.  The dashboard module is
 *   an ES module bundled by esbuild for the browser; we replicate the
 *   gate in CommonJS for direct test access.  Mirror is small enough to
 *   keep in lockstep by inspection — if you change one, change the
 *   other.  Same pattern as `test/dashboard-idle.test.js` and
 *   `test/dashboard-csrf-fetch.test.js`.
 *
 *   Bug under test: during burn-in, users observed a backlog of
 *   rebalance / compound jingles play in quick succession when they
 *   logged back into the desktop after hours away.  The polling
 *   trackers (`checkRebalanceSound`, `checkCompoundSound`) call
 *   `playSound` on every detected `lastRebalance/CompoundAt` change,
 *   so events that fired while the user was logged out queue up and
 *   all play on first poll after activity.
 *
 *   Fix: `playSound` skips when `isBrowserPaused()` is `true`.  The
 *   browser flag is independent of the move-scope override in
 *   `src/price-fetcher-gate.js` (item #4 of the four pause sources)
 *   so an auto-rebalance/compound that ran while the user was idle
 *   leaves `_browserHasPaused` still true — the gate suppresses the
 *   sound.  Activity events flip the flag synchronously, so any
 *   click-driven sound reaches the gate after it has cleared.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/* ── In-test replica of the gate ─────────────────────────────────────── */

let _soundsEnabled = true;
let _browserPaused = false;
let _alwaysCalls = [];

function isSoundsEnabled() {
  return _soundsEnabled;
}
function isBrowserPaused() {
  return _browserPaused;
}
function playSoundAlways(path) {
  _alwaysCalls.push(path);
}

function playSound(path) {
  if (!isSoundsEnabled()) return;
  if (isBrowserPaused()) return;
  playSoundAlways(path);
}

beforeEach(() => {
  _soundsEnabled = true;
  _browserPaused = false;
  _alwaysCalls = [];
});

/* ── Tests ───────────────────────────────────────────────────────────── */

describe("playSound idle gate", () => {
  it("plays when sounds enabled and browser not paused", () => {
    playSound("/media/x.mp3");
    assert.deepStrictEqual(_alwaysCalls, ["/media/x.mp3"]);
  });

  it("skips when master Sounds toggle is off", () => {
    _soundsEnabled = false;
    playSound("/media/x.mp3");
    assert.deepStrictEqual(_alwaysCalls, []);
  });

  it("skips when browser is paused (idle), even with sounds enabled", () => {
    _browserPaused = true;
    playSound("/media/x.mp3");
    assert.deepStrictEqual(
      _alwaysCalls,
      [],
      "polling-driven sounds must not fire while the dashboard is idle",
    );
  });

  it("resumes playing once the browser unpauses", () => {
    _browserPaused = true;
    playSound("/media/first.mp3");
    _browserPaused = false;
    playSound("/media/second.mp3");
    assert.deepStrictEqual(
      _alwaysCalls,
      ["/media/second.mp3"],
      "first call suppressed by idle gate, second call passes once flag clears",
    );
  });

  it("master toggle off beats idle gate (no double-play on resume)", () => {
    _soundsEnabled = false;
    _browserPaused = true;
    playSound("/media/x.mp3");
    _browserPaused = false;
    playSound("/media/x.mp3");
    assert.deepStrictEqual(_alwaysCalls, []);
  });

  it("mirrors the gate ordering in dashboard-sounds.js (sounds-toggle first, idle second)", () => {
    /*- If the toggle is off the gate must not even consult the idle
     *  flag — keeps the gate cheap and matches the source ordering. */
    _soundsEnabled = false;
    let consulted = false;
    const origIsBrowserPaused = isBrowserPaused;
    const spy = () => {
      consulted = true;
      return origIsBrowserPaused();
    };
    /*- Inline replay of the gate using the spy. */
    (function gate() {
      if (!isSoundsEnabled()) return;
      if (spy()) return;
      playSoundAlways("/media/x.mp3");
    })();
    assert.strictEqual(consulted, false);
    assert.deepStrictEqual(_alwaysCalls, []);
  });
});
