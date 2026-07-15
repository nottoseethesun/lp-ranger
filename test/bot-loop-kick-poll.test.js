/**
 * @file test/bot-loop-kick-poll.test.js
 * @description Mirror tests for the `_kickPoll` + `pendingKick`
 * scheduler pattern inside `src/bot-loop.js`.  The full startBotLoop
 * closure is difficult to exercise in isolation (requires provider,
 * signer, position detector, and a live poll runner) — this mirror
 * re-implements the ~15 lines of scheduler + kick logic in a
 * self-contained shape so the design invariants can be pinned down
 * without booting the whole bot machinery.  If a future refactor
 * changes the semantics of `_kickPoll` or `_scheduleNext`, the
 * mirror below must be updated in lockstep.
 *
 * Invariants under test:
 *   1. Kick when the poll is idle → cancels the pending timer and
 *      schedules a poll for 0 ms.
 *   2. Kick when a poll is in-flight → sets `pendingKick`.  The
 *      in-flight poll is left alone; when it finishes and its tail
 *      calls `_scheduleNext(…)`, `pendingKick` forces the delay to
 *      0 ms and the flag clears.
 *   3. Kick after `stop()` → no-op.  A stopped loop must not
 *      resurrect itself.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/*- Mirror of the closure in src/bot-loop.js (near line 175):
 *    let currentIntervalMs = ..., timer = null, pendingKick = false;
 *    let polling = false, _stopped = false;
 *    function _scheduleNext(ms) { ... }
 *    botState._kickPoll = () => { ... }
 *  The mirror uses caller-visible spies for setTimeout / clearTimeout
 *  so we can assert on delays instead of waiting real wall-clock
 *  time. */
function makeScheduler({
  defaultIntervalMs,
  setTimeoutSpy,
  clearTimeoutSpy,
  poll,
}) {
  let timer = null;
  let pendingKick = false;
  let polling = false;
  let stopped = false;

  function scheduleNext(ms) {
    clearTimeoutSpy(timer);
    const delay = pendingKick ? 0 : (ms ?? defaultIntervalMs);
    pendingKick = false;
    timer = setTimeoutSpy(poll, delay);
  }

  function kickPoll() {
    if (stopped) return;
    if (polling) {
      pendingKick = true;
      return;
    }
    clearTimeoutSpy(timer);
    timer = setTimeoutSpy(poll, 0);
  }

  return {
    scheduleNext,
    kickPoll,
    setPolling(v) {
      polling = v;
    },
    setStopped(v) {
      stopped = v;
    },
    peekPendingKick: () => pendingKick,
  };
}

function makeSpies() {
  const timeoutCalls = [];
  const clearedTimers = [];
  let nextId = 1;
  return {
    setTimeoutSpy: (fn, ms) => {
      const id = nextId++;
      timeoutCalls.push({ id, fn, ms });
      return id;
    },
    clearTimeoutSpy: (id) => {
      if (id !== null && id !== undefined) clearedTimers.push(id);
    },
    timeoutCalls,
    clearedTimers,
  };
}

describe("bot-loop scheduler — _kickPoll + pendingKick", () => {
  it("kick when idle: cancels pending timer + schedules a poll for 0 ms", () => {
    const spies = makeSpies();
    const s = makeScheduler({
      defaultIntervalMs: 300_000,
      poll: () => {},
      ...spies,
    });
    s.scheduleNext(); // arms the timer for the default interval
    const armedId = spies.timeoutCalls[0].id;
    assert.equal(
      spies.timeoutCalls[0].ms,
      300_000,
      "initial arm at default interval",
    );

    s.kickPoll();
    assert.ok(
      spies.clearedTimers.includes(armedId),
      "kickPoll must clearTimeout the pending timer",
    );
    assert.equal(
      spies.timeoutCalls[1].ms,
      0,
      "kickPoll must schedule a new poll for 0 ms",
    );
  });

  it("kick while polling: sets pendingKick, leaves timer/schedule alone", () => {
    const spies = makeSpies();
    const s = makeScheduler({
      defaultIntervalMs: 300_000,
      poll: () => {},
      ...spies,
    });
    s.setPolling(true);
    s.kickPoll();
    assert.equal(
      spies.timeoutCalls.length,
      0,
      "kick during polling must NOT touch setTimeout — the in-flight poll's tail will reschedule",
    );
    assert.equal(s.peekPendingKick(), true, "pendingKick must be armed");
  });

  it("scheduleNext consumes pendingKick and fires the NEXT poll at 0 ms", () => {
    const spies = makeSpies();
    const s = makeScheduler({
      defaultIntervalMs: 300_000,
      poll: () => {},
      ...spies,
    });
    /*- Simulate: poll is running (polling=true), user kicks it,
     *  poll ends (polling=false), tail scheduleNext fires. */
    s.setPolling(true);
    s.kickPoll();
    s.setPolling(false);
    s.scheduleNext();
    assert.equal(
      spies.timeoutCalls[0].ms,
      0,
      "tail scheduleNext must honour pendingKick with a 0 ms delay",
    );
    assert.equal(
      s.peekPendingKick(),
      false,
      "scheduleNext must clear pendingKick after consuming it",
    );
  });

  it("scheduleNext defaults when pendingKick is not set", () => {
    const spies = makeSpies();
    const s = makeScheduler({
      defaultIntervalMs: 300_000,
      poll: () => {},
      ...spies,
    });
    s.scheduleNext();
    assert.equal(spies.timeoutCalls[0].ms, 300_000);
    s.scheduleNext(2_000);
    assert.equal(
      spies.timeoutCalls[1].ms,
      2_000,
      "explicit ms argument must be honoured when no pendingKick",
    );
  });

  it("kick after stop: no-op (does not resurrect the loop)", () => {
    const spies = makeSpies();
    const s = makeScheduler({
      defaultIntervalMs: 300_000,
      poll: () => {},
      ...spies,
    });
    s.setStopped(true);
    s.kickPoll();
    assert.equal(
      spies.timeoutCalls.length,
      0,
      "kickPoll on a stopped loop must be a no-op",
    );
    assert.equal(s.peekPendingKick(), false);
  });
});
