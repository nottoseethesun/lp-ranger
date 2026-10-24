"use strict";

/**
 * @file test/il-guard-gate.test.js
 * @description Tests for `checkIlGuard` — the Impermanent Loss Guard as
 * it applies to a poll cycle.  The pure rules it calls are tested in
 * `il-guard.test.js`; the two split when that file passed the 500-line
 * cap.
 *
 * Two properties matter more than the arithmetic, and both are pinned
 * here:
 *
 *   1. **A rejection never drains.**  The guard is a calculation over
 *      figures the poll cycle already has, and it runs upstream of
 *      `executeRebalance`.  There is no path from "rejected" to
 *      `decreaseLiquidity` or `collect`.  The gate is driven with deps
 *      whose every chain-touching collaborator would throw if called.
 *   2. **A rejection is not a rebalance.**  It must never advance the
 *      daily cap or the doubling window, because no rebalance happened.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  checkIlGuard,
  clearIlGuardWait,
  ilGuardWillMeasure,
} = require("../src/il-guard");
const { isRecoveryResult } = require("../src/bot-loop");
const { ilSnapshot } = require("./helpers/il-snapshot");

describe("checkIlGuard — the gate", () => {
  /*- Every collaborator that could touch the chain throws.  If the gate
   *  ever grew a chain read or a drain, these tests would fail rather
   *  than quietly pass. */
  const explode = (name) => () => {
    throw new Error(`${name} must never be called by the ILG gate`);
  };

  let deps;

  beforeEach(() => {
    deps = {
      position: {
        tokenId: "164418",
        fee: 2500,
        token0: "0xA",
        token1: "0xB",
        liquidity: "1000",
      },
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? 50 : undefined),
      _botState: {},
      provider: new Proxy({}, { get: () => explode("provider") }),
      signer: new Proxy({}, { get: () => explode("signer") }),
    };
  });

  const notifyPos = (p) => ({ tokenId: p.tokenId });

  it("a rejection counts as no rebalance at all", () => {
    /*- The user must never see the daily cap tick up for a rebalance
     *  that did not happen.  `throttle.recordRebalance()` and
     *  `_recordPoolRebalance` both live in `_handleRebalanceSuccess`,
     *  which is only reached after `executeRebalance` returns — and the
     *  gate returns before `executeRebalance` is called.  Wired to throw
     *  so the guarantee is enforced rather than assumed. */
    deps.throttle = {
      recordRebalance: explode("throttle.recordRebalance"),
      canRebalance: explode("throttle.canRebalance"),
    };
    deps._recordPoolRebalance = explode("_recordPoolRebalance");
    deps._poolKey = explode("_poolKey");
    const r = checkIlGuard(deps, false, ilSnapshot(480, 1000), notifyPos);
    assert.deepEqual(r, { rebalanced: false, ilGuardRejected: true });
  });

  it("rejects a position below the floor without touching it", () => {
    const r = checkIlGuard(deps, false, ilSnapshot(480, 1000), notifyPos);
    assert.deepEqual(r, { rebalanced: false, ilGuardRejected: true });
  });

  it("returns null — proceed — when above the floor", () => {
    assert.equal(
      checkIlGuard(deps, false, ilSnapshot(640, 1000), notifyPos),
      null,
    );
  });

  it("is skipped entirely for a user-forced rebalance", () => {
    /*-
     *  Rebalance Now skips the Guard, as it skips every other gate here.
     *  It has already shown its own impermanent-loss confirmation.
     */
    assert.equal(
      checkIlGuard(deps, true, ilSnapshot(1, 1000), notifyPos),
      null,
      "a forced rebalance must pass even at a total loss",
    );
  });

  it("proceeds before the snapshot carries IL/G", () => {
    /*-
     *  The minted coins not read yet: there is nothing to measure
     *  against, and the Guard fails open.
     */
    assert.equal(
      checkIlGuard(deps, false, { currentValue: 1 }, notifyPos),
      null,
    );
  });

  it("still guards a position with no saved value", () => {
    /*-
     *  An unset key falls back to the shipped default, so the Guard is
     *  live out of the box.  A position worth $1 against $1,000 of
     *  holding must be refused whether or not anyone opened Bot
     *  Settings.
     */
    deps._getConfig = () => undefined;
    assert.deepEqual(
      checkIlGuard(deps, false, ilSnapshot(1, 1000), notifyPos),
      {
        rebalanced: false,
        ilGuardRejected: true,
      },
    );
  });

  it("proceeds when there is no snapshot to project from", () => {
    assert.equal(checkIlGuard(deps, false, null, notifyPos), null);
  });

  it("stands aside while the position holds no liquidity, even at a total loss", () => {
    /*-
     *  A rebalance that emptied the old position and failed to mint is
     *  retried as an automatic rebalance. The Guard counts no coin in the
     *  wallet, so it would see an empty position worth nothing against
     *  holding, a 100% loss, and leave the coins idle.
     */
    deps.position.liquidity = "0";
    assert.equal(
      checkIlGuard(deps, false, ilSnapshot(0, 1000), notifyPos),
      null,
    );
    assert.equal(
      ilGuardWillMeasure(deps, false),
      false,
      "no fresh prices for it",
    );
    deps.position.liquidity = "1000";
    assert.equal(ilGuardWillMeasure(deps, false), true);
  });

  it("stands aside for an empty position during a wait left by an earlier rejection", () => {
    const first = checkIlGuard(deps, false, ilSnapshot(480, 1000), notifyPos);
    assert.equal(first?.ilGuardRejected, true, "rejected while live");
    deps.position.liquidity = "0";
    assert.equal(
      checkIlGuard(deps, false, ilSnapshot(0, 1000), notifyPos),
      null,
      "the wait holds no mint",
    );
  });
});

describe("checkIlGuard — the retry backoff", () => {
  /*- Once rejected, the position is left alone for a widening interval
   *  rather than re-decided every poll.  The same stamp paces the
   *  Telegram alert, so a long block reports on the same schedule. */
  const notifyPos = (p) => ({ tokenId: p.tokenId });
  const H = 3_600_000;
  let deps;

  beforeEach(() => {
    deps = {
      position: { tokenId: "164418", liquidity: "1000" },
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? 50 : undefined),
      _botState: {},
    };
  });

  const poll = (positionUsd) =>
    checkIlGuard(deps, false, ilSnapshot(positionUsd, 1000), notifyPos);
  /**
   * A poll whose snapshot carries no IL/G, which fails open whenever
   * the Guard actually decides.
   */
  const pollUnmeasured = () => checkIlGuard(deps, false, {}, notifyPos);

  /*- Wind the clock back so the current window has elapsed. */
  const elapse = (hours) => {
    deps._botState._ilGuardRejectedAt = Date.now() - hours * H - 1000;
  };

  it("records the episode on the first refusal", () => {
    const before = Date.now();
    poll(480);
    assert.ok(deps._botState._ilGuardRejectedAt >= before, "clock started");
    assert.equal(deps._botState._ilGuardRejectCount, 1);
  });

  it("keeps refusing inside the window, without re-deciding", () => {
    /*- The backoff silences the retry and the alert, never the refusal.
     *  Every poll inside the window must still say no. */
    poll(480);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(pollUnmeasured(), {
        rebalanced: false,
        ilGuardRejected: true,
        ilGuardCoolingDown: true,
      });
    }
    assert.equal(deps._botState._ilGuardRejectCount, 1, "no double-count");
  });

  it("holds even once the position has recovered", () => {
    /*- The accepted cost of the backoff: a position that comes back
     *  inside the window waits for it to expire. */
    poll(480);
    assert.equal(poll(2000).ilGuardCoolingDown, true);
  });

  it("widens the wait with each consecutive rejection", () => {
    poll(480);
    assert.equal(deps._botState._ilGuardRejectCount, 1);
    elapse(4);
    poll(480);
    assert.equal(deps._botState._ilGuardRejectCount, 2, "second refusal");
    /*- Now on the 8 h rung: 5 h elapsed is no longer enough. */
    elapse(5);
    assert.equal(poll(480).ilGuardCoolingDown, true, "still inside 8h");
    elapse(9);
    assert.equal(
      poll(480).ilGuardCoolingDown,
      undefined,
      "9h clears the 8h rung",
    );
    assert.equal(deps._botState._ilGuardRejectCount, 3);
  });

  it("re-decides once the window has elapsed", () => {
    poll(480);
    elapse(4);
    const r = poll(480);
    assert.equal(r.ilGuardCoolingDown, undefined, "evaluated afresh");
    assert.equal(r.ilGuardRejected, true, "still below the floor");
    assert.ok(Date.now() - deps._botState._ilGuardRejectedAt < 1000);
  });

  it("resets the ladder when the position recovers", () => {
    /*- A position that recovers and later falls again starts over at 4 h
     *  rather than resuming a long wait. */
    poll(480);
    elapse(4);
    poll(480);
    assert.equal(deps._botState._ilGuardRejectCount, 2);
    elapse(8);
    assert.equal(poll(640), null, "recovered — rebalance proceeds");
    assert.equal(deps._botState._ilGuardRejectedAt, 0);
    assert.equal(deps._botState._ilGuardRejectCount, 0, "ladder reset");
    poll(480);
    assert.equal(deps._botState._ilGuardRejectCount, 1, "back on the 4h rung");
  });

  it("resets the ladder when the guard stops being evaluable", () => {
    /*-
     *  e.g. a Reload wiped the minted coins.  Leaving the stamp would
     *  hold the next real episode on a stale schedule.
     */
    poll(480);
    elapse(4);
    assert.equal(pollUnmeasured(), null);
    assert.equal(deps._botState._ilGuardRejectedAt, 0);
    assert.equal(deps._botState._ilGuardRejectCount, 0);
  });

  it("never holds a manual Rebalance Now", () => {
    poll(480);
    assert.equal(
      checkIlGuard(deps, true, ilSnapshot(1, 1000), notifyPos),
      null,
      "a forced rebalance ignores both the guard and its backoff",
    );
  });
});

describe("checkIlGuard — the block the dashboard shows after a Guard save", () => {
  /*-
   *  A rejection publishes `ilGuardBlocked`, which the dashboard shows as
   *  the "Rebalance skipped — impermanent loss" dialog until the bot
   *  publishes it null. Saving the Guard lifts the wait at once
   *  (`clearIlGuardWait`) and leaves the block for the next check to
   *  lift or word again. The state here is merged into as the server's
   *  is, so what the bot published is what it reads.
   */

  const notifyPos = (p) => ({ tokenId: p.tokenId });
  let deps;
  let guardPct;

  beforeEach(() => {
    guardPct = 50;
    deps = {
      position: { tokenId: "164418", liquidity: "1000" },
      _getConfig: (k) =>
        k === "impermanentLossGuardPct" ? guardPct : undefined,
      _botState: {},
    };
    deps.updateBotState = (patch) => Object.assign(deps._botState, patch);
  });

  const poll = (positionUsd) =>
    checkIlGuard(deps, false, ilSnapshot(positionUsd, 1000), notifyPos);

  it("is lifted when the raised Guard lets the rebalance through", () => {
    poll(480);
    assert.ok(deps._botState.ilGuardBlocked, "the rejection is published");
    clearIlGuardWait(deps._botState);
    guardPct = 60;
    assert.equal(poll(480), null, "the raised Guard passes it");
    assert.equal(deps._botState.ilGuardBlocked, null, "the dialog goes");
  });

  it("is lifted when the next check cannot measure the position", () => {
    poll(480);
    clearIlGuardWait(deps._botState);
    assert.equal(checkIlGuard(deps, false, {}, notifyPos), null);
    assert.equal(deps._botState.ilGuardBlocked, null);
  });

  it("is worded again when the next check rejects again", () => {
    poll(480);
    clearIlGuardWait(deps._botState);
    // A 52% loss: still past a Guard of 51, whose floor is $490.
    guardPct = 51;
    assert.equal(poll(480).ilGuardRejected, true);
    assert.match(deps._botState.ilGuardBlocked.message, /set to 51%/);
  });
});

describe("checkIlGuard — the shipped default actually applies", () => {
  /*- The bug this pins: `readConfigValue` returns undefined for a key
   *  that was never saved, and does NOT consult the layered defaults
   *  file — consumers apply the shipped default themselves.  Without
   *  that fallback the Guard was inert on every position until the user
   *  opened Bot Settings and pressed Save, which is the opposite of
   *  shipping it on by default. */
  const notifyPos = (p) => ({ tokenId: p.tokenId });

  const virgin = () => ({
    position: { tokenId: "164418", liquidity: "1000" },
    /*- Nothing saved for this position — the normal state of every
     *  position the user has never configured. */
    _getConfig: () => undefined,
    _botState: {},
  });
  // Holding the coins this position was minted with: $3,947.23 today.
  const at = (positionUsd) => ilSnapshot(positionUsd, 3947.23);

  it("guards a never-configured position", () => {
    const r = checkIlGuard(virgin(), false, at(500), notifyPos);
    assert.deepEqual(
      r,
      { rebalanced: false, ilGuardRejected: true },
      "an 87% loss must be refused at the shipped default",
    );
  });

  it("still allows a loss inside the shipped default", () => {
    assert.equal(
      checkIlGuard(virgin(), false, at(3600), notifyPos),
      null,
      "8.8% down sits inside the shipped 15%",
    );
  });

  it("a saved per-position value overrides the shipped default", () => {
    /*-
     *  29.4% below holding: refused by the shipped 15, allowed once the
     *  operator raises the guard to 50. The
     *  outcome flips, so it is the saved value deciding, not the default.
     *  Each case gets its own state — a rejection stamps the retry clock,
     *  and a second call on the same object would be held by it rather
     *  than re-decided.
     */
    const shipped = virgin();
    assert.ok(
      checkIlGuard(shipped, false, at(2788.65), notifyPos),
      "the shipped 15% refuses this one",
    );

    const raised = virgin();
    raised._getConfig = (k) =>
      k === "impermanentLossGuardPct" ? 50 : undefined;
    assert.equal(
      checkIlGuard(raised, false, at(2788.65), notifyPos),
      null,
      "the same loss passes once the guard is raised to 50",
    );
  });
});

describe("a blocked poll is not a recovery", () => {
  /*- `_processPollResult` in bot-loop.js acts on `isRecoveryResult` by
   *  clearing rebalanceError / rebalancePaused / rebalanceFailedMidway
   *  and raising the "Position Recovered" modal.  Deciding by
   *  elimination would read every gate that returns a bare
   *  `{rebalanced: false}` — throttle, pool daily cap, dry run, the ILG
   *  block — as a recovery: the dashboard would announce that a stuck
   *  position had come back, and discard the error explaining why it
   *  was stuck.  Pinned against the real predicate, not a copy. */
  const healthy = { rebalanceFailedMidway: false, rebalancePaused: false };

  /*- One row per distinct payload the poll cycle actually produces.
   *  The bare shape has five call sites and one shape — listing it five
   *  times would assert the same object five times and read as more
   *  coverage than it is. */
  const BLOCKED = [
    [
      "a gate that names no reason (throttle, pool daily cap, dry run, " +
        "aborted-and-drained, drain timer)",
      { rebalanced: false },
    ],
    [
      "out of range but within threshold",
      { rebalanced: false, withinThreshold: true },
    ],
    [
      "a rebalance the price outran",
      { rebalanced: false, priceVolatile: true },
    ],
    ["scan in progress", { rebalanced: false, scanRunning: true }],
    ["ILG rejection", { rebalanced: false, ilGuardRejected: true }],
    [
      "ILG backoff",
      { rebalanced: false, ilGuardRejected: true, ilGuardCoolingDown: true },
    ],
    /*- `paused` and `retired` carry no explicit clause in the
     *  predicate; asserting `inRange` subsumes both, since neither
     *  result can carry it.  These rows prove that. */
    ["gate pause", { rebalanced: false, paused: true }],
    ["drained + retiring", { rebalanced: false, retired: true }],
    [
      "a stopped loop's skipped rebalance",
      { rebalanced: false, stopped: true },
    ],
  ];

  for (const [name, result] of BLOCKED) {
    it(`does not treat ${name} as recovery`, () => {
      assert.equal(isRecoveryResult(result, healthy), false);
    });
  }

  it("recognises the one signal that IS a recovery", () => {
    /*- `inRange` is set by _checkRangeAndThreshold before any gate
     *  runs, so no blocked result can carry it — which is exactly why
     *  the predicate asserts it rather than enumerating blockers. */
    assert.equal(
      isRecoveryResult({ rebalanced: false, inRange: true }, healthy),
      true,
    );
  });

  it("still holds a position that is in range but not clear yet", () => {
    for (const st of [
      { rebalanceFailedMidway: true, rebalancePaused: false },
      { rebalanceFailedMidway: false, rebalancePaused: true },
    ])
      assert.equal(
        isRecoveryResult({ rebalanced: false, inRange: true }, st),
        false,
      );
  });
});
