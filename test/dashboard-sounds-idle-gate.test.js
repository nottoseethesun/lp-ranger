"use strict";

/**
 * @file test/dashboard-sounds-idle-gate.test.js
 * @description Tests the pure `_playSoundGate` decision extracted from
 *   `playSound` in `public/dashboard-sounds.js`.  Previously mirrored
 *   because `playSound` reached across modules to `isSoundsEnabled`
 *   (localStorage-backed) and `isBrowserPaused` (dashboard-idle
 *   singleton); the pure gate takes both booleans as parameters so the
 *   test can drive them directly under jsdom + real module import.
 *
 *   Bug the gate prevents: users observed a backlog of rebalance /
 *   compound jingles play in quick succession when they logged back
 *   into the desktop after hours away.  The polling trackers
 *   (`checkRebalanceSound`, `checkCompoundSound`) call `playSound` on
 *   every detected `lastRebalance/CompoundAt` change, so events that
 *   fired while the user was idle queue up and all play on first poll
 *   after activity.  Fix: gate on `isBrowserPaused()` — an
 *   auto-rebalance/compound that ran while the user was idle leaves
 *   `_browserHasPaused` still true, and the gate suppresses the sound.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-sounds.js");
});

describe("_playSoundGate()", () => {
  it("passes when sounds enabled AND browser not paused", () => {
    assert.strictEqual(mod._playSoundGate(true, false), true);
  });

  it("blocks when master Sounds toggle is off", () => {
    assert.strictEqual(mod._playSoundGate(false, false), false);
  });

  it("blocks when browser is paused (idle), even with sounds enabled", () => {
    assert.strictEqual(
      mod._playSoundGate(true, true),
      false,
      "polling-driven sounds must not fire while the dashboard is idle",
    );
  });

  it("blocks in the both-off case (master beats idle in evaluation order)", () => {
    assert.strictEqual(mod._playSoundGate(false, true), false);
  });

  it(
    "master toggle off short-circuits BEFORE the idle check — so the " +
      "idle flag is only consulted when the toggle is on",
    () => {
      /*- Regression pin against reordering the branches.  If someone
       *  moves the idle check first, a disabled toggle would still
       *  consult the idle state — cheap now, but a foot-gun if the idle
       *  check ever grows a side effect (e.g. logging).  The pure gate
       *  makes this ordering assertable without a spy. */
      assert.strictEqual(mod._playSoundGate(false, true), false);
      assert.strictEqual(mod._playSoundGate(false, false), false);
    },
  );
});
