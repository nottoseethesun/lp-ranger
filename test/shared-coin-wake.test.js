/**
 * @file test/shared-coin-wake.test.js
 * @description When a running managed position finishes its first check,
 * or stops, each other running position whose pool contains one of its
 * coins is checked again at once (src/lib/shared-coin-wake.js), so its
 * Wallet Residual (Pool) line divides the wallet's coins by the positions
 * as they now are. Driven through the update every position's state
 * takes (`updatePositionState`, src/lib/server-positions.js).
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  joinOrLeave,
  wakeOthersSharingACoin,
} = require("../src/lib/shared-coin-wake");
const {
  updatePositionState,
  getAllPositionBotStates,
} = require("../src/lib/server-positions");
const { claimScanStart, endScan } = require("../src/lib/scan-state");
const {
  markStopping,
  _resetAppPhaseForTests,
} = require("../src/lib/app-phase");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/**
 * A position whose pool contains `token0` and `token1`, counting the times
 * it is woken.
 */
function position(token0, token1, tokenId, running = true) {
  const state = {
    running,
    activePosition: {
      token0,
      token1,
      tokenId,
      token0Symbol: "T0",
      token1Symbol: "T1",
    },
    woken: 0,
  };
  state._kickPoll = () => {
    state.woken += 1;
  };
  return state;
}

describe("joinOrLeave", () => {
  it("is a join when the position's state first carries the coins its NFT contains", () => {
    assert.equal(
      joinOrLeave({ running: true }, { positionStats: {} }),
      "joins",
    );
    assert.equal(
      joinOrLeave({ running: true, positionStats: {} }, { positionStats: {} }),
      null,
    );
  });

  it("is a leave when the position stops", () => {
    assert.equal(joinOrLeave({ running: true }, { running: false }), "leaves");
    assert.equal(joinOrLeave({ running: false }, { running: false }), null);
    assert.equal(joinOrLeave({ running: true }, { rebalanceCount: 1 }), null);
  });
});

describe("wakeOthersSharingACoin", () => {
  it("wakes each other running position whose pool contains one of the coins, unless its scan is running", () => {
    const changed = position("0xC", "0xX", "1");
    const sharer = position("0xY", "0xc", "2");
    const stranger = position("0xY", "0xZ", "3");
    const stopped = position("0xc", "0xZ", "4", false);
    const scanning = position("0xx", "0xZ", "5");
    assert.equal(claimScanStart(scanning), true);
    try {
      const states = [changed, sharer, stranger, stopped, scanning];
      assert.equal(wakeOthersSharingACoin(states, changed, "joins"), 1);
      assert.deepEqual(
        states.map((s) => s.woken),
        [0, 1, 0, 0, 0],
      );
    } finally {
      endScan(scanning);
    }
  });

  it("wakes none while the app itself is stopping", () => {
    const changed = position("0xc", "0xX", "1");
    const sharer = position("0xY", "0xc", "2");
    markStopping();
    try {
      assert.equal(
        wakeOthersSharingACoin([changed, sharer], changed, "leaves"),
        0,
      );
      assert.equal(sharer.woken, 0);
    } finally {
      _resetAppPhaseForTests();
    }
  });
});

describe("a position's state update", () => {
  const keys = [];
  afterEach(() => {
    for (const k of keys.splice(0)) getAllPositionBotStates().delete(k);
  });

  /** Put `state` in the server's map of position states, as a start does. */
  function register(key, state) {
    getAllPositionBotStates().set(key, state);
    keys.push(key);
    return state;
  }

  /** The update the bot loop of the position under `key` makes. */
  function updaterFor(key) {
    const keyRef = { current: key };
    const diskConfig = { global: {}, positions: {} };
    const dir = makeTestTempFolder("shared-coin-wake");
    return (patch) =>
      updatePositionState(keyRef, patch, diskConfig, { migrateKey() {} }, dir);
  }

  it("wakes a position sharing a coin once the other's first check has saved its NFT's coins, and again when it stops", () => {
    const sharer = register(
      "shared-coin-wake-sharer",
      position("0xY", "0xc", "2"),
    );
    register("shared-coin-wake-starting", {
      running: true,
      activePosition: { token0: "0xc", token1: "0xX", tokenId: "1" },
    });
    const update = updaterFor("shared-coin-wake-starting");
    update({ positionStats: { balance0: "100", balance1: "0" } });
    assert.equal(sharer.woken, 1, "its first check's coins");
    update({ positionStats: { balance0: "90", balance1: "1" } });
    assert.equal(sharer.woken, 1, "a later check's coins");
    update({ running: false });
    assert.equal(sharer.woken, 2, "its stop");
  });
});
