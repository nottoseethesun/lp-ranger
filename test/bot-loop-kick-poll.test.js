/**
 * @file test/bot-loop-kick-poll.test.js
 * @description Tests the real `createBotPollScheduler` factory from
 *   `src/bot-loop-scheduler.js`.  The scheduler + kick logic was
 *   extracted from the closure inside `startBotLoop` (bot-loop.js) so
 *   the invariants can be pinned against the real code — no mirror.
 *
 *   Invariants under test:
 *     1. Kick when the poll is idle → cancels the pending timer and
 *        schedules a poll for 0 ms.
 *     2. Kick when a poll is in-flight → sets `pendingKick`.  The
 *        in-flight poll is left alone; when it finishes and its tail
 *        calls `scheduleNext(...)`, `pendingKick` forces the delay to
 *        0 ms and the flag clears.
 *     3. Kick after `stop()` → no-op.  A stopped loop must not
 *        resurrect itself.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createBotPollScheduler } = require("../src/bot-loop-scheduler");

function makeSpies() {
  const timeoutCalls = [];
  const clearedTimers = [];
  let nextId = 1;
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timeoutCalls.push({ id, fn, ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      if (id !== null && id !== undefined) clearedTimers.push(id);
    },
    timeoutCalls,
    clearedTimers,
  };
}

let spies;
let poll;
let _pollCalls;
let scheduler;

beforeEach(() => {
  spies = makeSpies();
  _pollCalls = 0;
  poll = () => {
    _pollCalls++;
  };
  scheduler = createBotPollScheduler({
    defaultIntervalMs: 300_000,
    setTimeoutFn: spies.setTimeoutFn,
    clearTimeoutFn: spies.clearTimeoutFn,
    poll,
  });
});

describe("bot-loop scheduler — kickPoll + pendingKick", () => {
  it("kick when idle: cancels pending timer + schedules a poll for 0 ms", () => {
    // Prime a timer via the tail scheduleNext.
    scheduler.scheduleNext();
    const firstId = spies.timeoutCalls.at(-1).id;

    // Then kick — expected: clear firstId, schedule new timer at 0 ms.
    scheduler.kickPoll();
    assert.ok(
      spies.clearedTimers.includes(firstId),
      "kickPoll must cancel the pending timer",
    );
    const kicked = spies.timeoutCalls.at(-1);
    assert.strictEqual(kicked.ms, 0, "kickPoll must schedule at 0 ms");
  });

  it("kick while polling in-flight: latches pendingKick without scheduling", () => {
    scheduler.setPolling(true);
    const timeoutCountBefore = spies.timeoutCalls.length;
    scheduler.kickPoll();
    assert.strictEqual(
      spies.timeoutCalls.length,
      timeoutCountBefore,
      "kickPoll must NOT schedule while polling is in flight",
    );
    assert.strictEqual(scheduler.peekPendingKick(), true);
  });

  it("tail scheduleNext honors pendingKick: uses 0 ms and clears the flag", () => {
    scheduler.setPolling(true);
    scheduler.kickPoll();
    assert.strictEqual(scheduler.peekPendingKick(), true);

    scheduler.setPolling(false);
    scheduler.scheduleNext(); // tail of the completed poll

    const tail = spies.timeoutCalls.at(-1);
    assert.strictEqual(tail.ms, 0, "scheduleNext must honor pendingKick");
    assert.strictEqual(
      scheduler.peekPendingKick(),
      false,
      "pendingKick must clear after being consumed",
    );
  });

  it("kick after stop(): no-op — a stopped loop must not resurrect", () => {
    scheduler.stop();
    const beforeCount = spies.timeoutCalls.length;
    scheduler.kickPoll();
    assert.strictEqual(
      spies.timeoutCalls.length,
      beforeCount,
      "kickPoll must no-op after stop()",
    );
  });

  it("scheduleNext with explicit ms uses that value (unless pendingKick is latched)", () => {
    scheduler.scheduleNext(2000);
    assert.strictEqual(spies.timeoutCalls.at(-1).ms, 2000);

    scheduler.setPolling(true);
    scheduler.kickPoll();
    scheduler.setPolling(false);
    scheduler.scheduleNext(2000);
    assert.strictEqual(
      spies.timeoutCalls.at(-1).ms,
      0,
      "pendingKick overrides the explicit ms",
    );
  });

  it("scheduleNext with no argument falls back to defaultIntervalMs", () => {
    scheduler.scheduleNext();
    assert.strictEqual(spies.timeoutCalls.at(-1).ms, 300_000);
  });

  it("cancel() clears the timer without stopping the scheduler", () => {
    scheduler.scheduleNext();
    const firstId = spies.timeoutCalls.at(-1).id;
    scheduler.cancel();
    assert.ok(spies.clearedTimers.includes(firstId));
    // Not stopped — a subsequent kick should still schedule.
    scheduler.kickPoll();
    assert.strictEqual(spies.timeoutCalls.at(-1).ms, 0);
  });

  it("stop() clears the timer AND blocks future kicks", () => {
    scheduler.scheduleNext();
    const firstId = spies.timeoutCalls.at(-1).id;
    scheduler.stop();
    assert.ok(spies.clearedTimers.includes(firstId));
    const beforeCount = spies.timeoutCalls.length;
    scheduler.kickPoll();
    assert.strictEqual(
      spies.timeoutCalls.length,
      beforeCount,
      "kickPoll no-ops after stop()",
    );
  });
});
