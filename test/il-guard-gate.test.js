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

const { checkIlGuard } = require("../src/il-guard");
const { isRecoveryResult } = require("../src/bot-loop");

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
      position: { tokenId: "164418", fee: 2500, token0: "0xA", token1: "0xB" },
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? 50 : undefined),
      _botState: { hodlBaseline: { entryValue: 1000 } },
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
    const r = checkIlGuard(deps, false, { currentValue: 480 }, notifyPos);
    assert.deepEqual(r, { rebalanced: false, ilGuardRejected: true });
  });

  it("rejects a position below the floor without touching it", () => {
    const r = checkIlGuard(deps, false, { currentValue: 480 }, notifyPos);
    assert.deepEqual(r, { rebalanced: false, ilGuardRejected: true });
  });

  it("returns null — proceed — when above the floor", () => {
    assert.equal(
      checkIlGuard(deps, false, { currentValue: 640 }, notifyPos),
      null,
    );
  });

  it("is skipped entirely for a user-forced rebalance", () => {
    /*- Rebalance Now always works, like every other gate here.  It has
     *  already shown its own impermanent-loss confirmation. */
    assert.equal(
      checkIlGuard(deps, true, { currentValue: 1 }, notifyPos),
      null,
      "a forced rebalance must pass even at a total loss",
    );
  });

  it("proceeds when the position has no baseline yet", () => {
    deps._botState = { hodlBaseline: null };
    assert.equal(
      checkIlGuard(deps, false, { currentValue: 1 }, notifyPos),
      null,
    );
  });

  it("still guards a position with no saved value", () => {
    /*- An unset key falls back to the shipped default, so the Guard is
     *  live out of the box.  A position worth $1 against a $1,000 mint
     *  must be refused whether or not anyone opened Bot Settings. */
    deps._getConfig = () => undefined;
    assert.deepEqual(
      checkIlGuard(deps, false, { currentValue: 1 }, notifyPos),
      {
        rebalanced: false,
        ilGuardRejected: true,
      },
    );
  });

  it("proceeds when there is no snapshot to project from", () => {
    assert.equal(checkIlGuard(deps, false, null, notifyPos), null);
  });

  it("credits the residual, which can lift a position over the floor", () => {
    /*- $480 LP alone is under the $500 floor; with $60 of pool residual
     *  the rebalance would mint $540 and is allowed. */
    const rejected = checkIlGuard(
      deps,
      false,
      { currentValue: 480 },
      notifyPos,
    );
    assert.ok(rejected, "without residual it rejects");
    /*- That refusal started the retry cooldown.  Clear it so the second
     *  probe is a fresh decision rather than the held one. */
    deps._botState._ilGuardRejectedAt = 0;
    const allowed = checkIlGuard(
      deps,
      false,
      { currentValue: 480, residualValueUsd: 60 },
      notifyPos,
    );
    assert.equal(allowed, null, "with residual folded in it proceeds");
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
      position: { tokenId: "164418" },
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? 50 : undefined),
      _botState: { hodlBaseline: { entryValue: 1000 } },
    };
  });

  const poll = (currentValue) =>
    checkIlGuard(deps, false, { currentValue }, notifyPos);

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
    deps._botState.hodlBaseline = null; // would otherwise fail open
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(poll(480), {
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
    /*- e.g. a Reload wiped the baseline.  Leaving the stamp would hold
     *  the next real episode on a stale schedule. */
    poll(480);
    elapse(4);
    deps._botState.hodlBaseline = null;
    assert.equal(poll(480), null);
    assert.equal(deps._botState._ilGuardRejectedAt, 0);
    assert.equal(deps._botState._ilGuardRejectCount, 0);
  });

  it("never holds a manual Rebalance Now", () => {
    poll(480);
    assert.equal(
      checkIlGuard(deps, true, { currentValue: 1 }, notifyPos),
      null,
      "a forced rebalance ignores both the guard and its backoff",
    );
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
    position: { tokenId: "164418" },
    /*- Nothing saved for this position — the normal state of every
     *  position the user has never configured. */
    _getConfig: () => undefined,
    _botState: { hodlBaseline: { entryValue: 3947.23 } },
  });

  it("guards a never-configured position", () => {
    const r = checkIlGuard(virgin(), false, { currentValue: 500 }, notifyPos);
    assert.deepEqual(
      r,
      { rebalanced: false, ilGuardRejected: true },
      "an 87% loss must be refused at the shipped 50%",
    );
  });

  it("still allows a loss inside the shipped default", () => {
    assert.equal(
      checkIlGuard(virgin(), false, { currentValue: 2788.65 }, notifyPos),
      null,
      "29% down passes a 50% guard",
    );
  });

  it("a saved per-position value overrides the shipped default", () => {
    const deps = virgin();
    deps._getConfig = (k) => (k === "impermanentLossGuardPct" ? 20 : undefined);
    assert.ok(
      checkIlGuard(deps, false, { currentValue: 2788.65 }, notifyPos),
      "the same 29% loss is refused at 20%",
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
    ["volatile-price deferral", { rebalanced: false, priceVolatile: true }],
    ["scan in progress", { rebalanced: false, scanRunning: true }],
    ["swap backoff", { rebalanced: false, swapBackoff: true }],
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
