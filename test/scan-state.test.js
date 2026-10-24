"use strict";

/**
 * @file test/scan-state.test.js
 * @description Whether a scan is running on a position, and whether one
 *   may start (src/scan-state.js): no move starts while a scan runs, and
 *   no scan starts until every move of the position is cleared, so none
 *   while a poll decides a rebalance or compound, and none while a
 *   Rebalance Now or Compound Now waits to be made. A waiting scan holds
 *   back no move. Whether a coin move is under way, which the server asks
 *   before a Reload Current Position or Re-scan Prices, covers that same
 *   window. Driven over a bare bot state, as the bot loop, the poll cycle
 *   and the server's routes mark it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isAscanRunningOnThisPosition,
  isAcoinMoveUnderWayOnThisPosition,
  isItOkayToStartAscan,
  duringMoveInitiation,
  claimScanStart,
  endScan,
} = require("../src/scan-state");

describe("isAscanRunningOnThisPosition", () => {
  it("is a scan running, never one waiting to start", () => {
    assert.equal(isAscanRunningOnThisPosition({ _scanRunning: true }), true);
    assert.equal(isAscanRunningOnThisPosition({ _scanWaiting: true }), false);
    assert.equal(isAscanRunningOnThisPosition({}), false);
    assert.equal(isAscanRunningOnThisPosition(undefined), false);
  });

  it("is up from a scan's start to its end", () => {
    const st = {};
    assert.equal(claimScanStart(st), true);
    assert.equal(isAscanRunningOnThisPosition(st), true);
    endScan(st);
    assert.equal(isAscanRunningOnThisPosition(st), false);
  });
});

describe("isAcoinMoveUnderWayOnThisPosition", () => {
  it("is up from a move's first gate to its end, even one turned down", async () => {
    /*-
     *  A move holds the rebalance lock, and raises rebalanceInProgress or
     *  compoundInProgress, only partway through; the window starts at the
     *  poll's first gate, before the Guard, the gas check and the wait for
     *  the lock.
     */
    const st = {};
    assert.equal(isAcoinMoveUnderWayOnThisPosition(st), false);
    let during = null;
    await duringMoveInitiation(st, async () => {
      during = isAcoinMoveUnderWayOnThisPosition(st);
    });
    assert.equal(during, true);
    assert.equal(isAcoinMoveUnderWayOnThisPosition(st), false);
  });

  it("is down again after a move that throws", async () => {
    const st = {};
    await assert.rejects(
      duringMoveInitiation(st, async () => {
        throw new Error("the move failed");
      }),
    );
    assert.equal(isAcoinMoveUnderWayOnThisPosition(st), false);
  });

  for (const flag of ["forceRebalance", "forceCompound"]) {
    it(`is up while ${flag} waits to be made`, () => {
      assert.equal(isAcoinMoveUnderWayOnThisPosition({ [flag]: true }), true);
    });
  }

  it("is down while the residual cleanup's rebalance waits, an automatic move", () => {
    const st = { forceRebalance: true, residualCleanupInProgress: true };
    assert.equal(isAcoinMoveUnderWayOnThisPosition(st), false);
  });

  it("is the one rule a scan's start reads", () => {
    for (const st of [
      {},
      { _moveInitiations: 1 },
      { forceRebalance: true },
      { forceCompound: true },
      { forceRebalance: true, residualCleanupInProgress: true },
    ])
      assert.equal(
        isItOkayToStartAscan(st),
        !isAcoinMoveUnderWayOnThisPosition(st),
      );
    assert.equal(isAcoinMoveUnderWayOnThisPosition(undefined), false);
  });
});

describe("a scan asked for while a poll decides a move", () => {
  it("waits for the move, and may start once it is over", async () => {
    const st = {};
    await duringMoveInitiation(st, async () => {
      assert.equal(isItOkayToStartAscan(st), false);
      assert.equal(claimScanStart(st), false, "it does not start now");
      assert.equal(st._scanWaiting, true);
      assert.equal(
        isAscanRunningOnThisPosition(st),
        false,
        "nor holds the move back",
      );
    });
    assert.equal(isItOkayToStartAscan(st), true);
    assert.equal(claimScanStart(st), true);
    assert.equal(st._scanWaiting, false);
  });

  it("lifts the hold even when the move throws", async () => {
    const st = {};
    await assert.rejects(
      duringMoveInitiation(st, async () => {
        throw new Error("the move failed");
      }),
    );
    assert.equal(isItOkayToStartAscan(st), true);
  });

  it("starts at once when no move is under way, and only once", () => {
    const st = {};
    assert.equal(claimScanStart(st), true);
    assert.equal(claimScanStart(st), false, "one runs already");
    assert.notEqual(st._scanWaiting, true, "a second ask does not wait");
  });
});

describe("a Rebalance Now or Compound Now waiting to be made", () => {
  for (const flag of ["forceRebalance", "forceCompound"]) {
    it(`holds scans back while ${flag} is up, however many polls pass`, async () => {
      /*-
       *  A Rebalance Now waiting for gas stays asked for across polls,
       *  each deciding it again; the scan waits all that time.
       */
      const st = { [flag]: true };
      for (let poll = 0; poll < 3; poll++)
        await duringMoveInitiation(st, async () => {});
      assert.equal(isItOkayToStartAscan(st), false);
      assert.equal(claimScanStart(st), false);
      assert.equal(st._scanWaiting, true);
      // The move clears its flag as it starts.
      st[flag] = false;
      assert.equal(isItOkayToStartAscan(st), true);
      assert.equal(claimScanStart(st), true);
    });
  }

  it("runs one scan for every scan asked for while it waited", () => {
    /*-
     *  Each scan is the same whole operation, so scans held back for a
     *  move resolve to one: the hold is one flag, and a scan asked for
     *  while that one runs is not run again.
     */
    const st = { forceRebalance: true };
    for (let ask = 0; ask < 4; ask++) assert.equal(claimScanStart(st), false);
    assert.equal(st._scanWaiting, true);
    st.forceRebalance = false;
    assert.equal(claimScanStart(st), true, "the one that waited");
    assert.equal(st._scanWaiting, false);
    for (let ask = 0; ask < 3; ask++) assert.equal(claimScanStart(st), false);
    assert.notEqual(st._scanWaiting, true, "none queued behind it");
    endScan(st);
    assert.notEqual(st._scanWaiting, true, "nothing left to run");
  });

  it("holds nothing back for the residual cleanup, an automatic move", () => {
    /*-
     *  The cleanup raises forceRebalance to pass the range check, and one
     *  the daily cap holds back keeps it raised for hours.
     */
    const st = { forceRebalance: true, residualCleanupInProgress: true };
    assert.equal(isItOkayToStartAscan(st), true);
  });
});

/*-
 *  Neither the bot loop's lifecycle nor the poll cycle's move paths has
 *  a test fixture of its own (docs/roadmap/nice-to-haves/
 *  project_bot_loop_test_scaffolding.md), so their use of these rules is
 *  pinned by shape.
 */
describe("the bot's use of these rules", () => {
  const read = (file) =>
    fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

  it("starts a waiting scan when a poll ends", () => {
    const src = read("bot-loop.js");
    assert.match(
      src,
      /finally \{\s*polling = false;\s*_scheduler\.setPolling\(false\);\s*_startWaitingScan\(\);/,
    );
    assert.match(src, /if \(botState\._scanWaiting !== true\) return;/);
  });

  it("claims each scan's start and marks its end", () => {
    const src = read("bot-loop.js");
    assert.match(src, /if \(!claimScanStart\(botState\)\) return;/);
    assert.match(src, /finally \{\s*endScan\(botState\);/);
    assert.match(src, /botState\._scanDone = _scanPass\(\);/);
  });

  it("decides each rebalance and compound inside the hold", () => {
    const src = read("bot-cycle.js");
    for (const path_ of [
      "_checkCompound(",
      "_decideRebalance(",
      "_handleForceCompound(",
    ])
      assert.match(
        src,
        new RegExp(
          "duringMoveInitiation\\(deps\\._botState, \\(\\) =>\\s*" +
            path_.replace("(", "\\("),
        ),
        `${path_} is decided inside duringMoveInitiation`,
      );
  });
});
