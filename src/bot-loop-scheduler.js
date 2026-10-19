/**
 * @file src/bot-loop-scheduler.js
 * @description Poll-scheduler factory extracted from the closure inside
 * `startBotLoop` in `src/bot-loop.js`.  Handles the pattern:
 *
 *   - `scheduleNext(ms)` — clear any pending timer, then set a new one
 *     for `ms` (or the default interval).  If `pendingKick` is set,
 *     override to 0 ms and clear the flag.
 *   - `kickPoll()` — external wake-up (manual Rebalance / Compound
 *     endpoints).  If the poll is in-flight, latch `pendingKick` so
 *     the tail `scheduleNext` in the current poll fires the next one
 *     immediately.  If the poll is idle, cancel the pending timer and
 *     fire `poll(0)`.  A stopped loop must not resurrect itself.
 *
 * Extracted so tests can drive the invariants without booting a full
 * bot loop (provider, signer, position detector, live poll runner).
 * `startBotLoop` composes this with `setPolling` / `setStopped`
 * callbacks to reflect its own state transitions.
 */

"use strict";

/**
 * Create a poll-scheduler with injected `setTimeout` / `clearTimeout`
 * hooks so tests can control timing without wall-clock waits.
 *
 * @param {object} opts
 * @param {number} opts.defaultIntervalMs   Fallback delay when caller passes no ms.
 * @param {Function} opts.setTimeoutFn      Usually `setTimeout` — override for tests.
 * @param {Function} opts.clearTimeoutFn    Usually `clearTimeout` — override for tests.
 * @param {Function} opts.poll              The poll function invoked on timer fire.
 * @returns {{
 *   scheduleNext: (ms?: number) => void,
 *   kickPoll: () => void,
 *   setPolling: (v: boolean) => void,
 *   setStopped: (v: boolean) => void,
 *   peekPendingKick: () => boolean,
 * }}
 */
function createBotPollScheduler({
  defaultIntervalMs,
  setTimeoutFn,
  clearTimeoutFn,
  poll,
}) {
  let timer = null;
  let pendingKick = false;
  let polling = false;
  let stopped = false;

  function scheduleNext(ms) {
    clearTimeoutFn(timer);
    const delay = pendingKick ? 0 : (ms ?? defaultIntervalMs);
    pendingKick = false;
    timer = setTimeoutFn(poll, delay);
  }

  function kickPoll() {
    if (stopped) return;
    if (polling) {
      pendingKick = true;
      return;
    }
    clearTimeoutFn(timer);
    timer = setTimeoutFn(poll, 0);
  }

  /**
   * Cancel any pending timer without stopping the scheduler — used
   * before a long-running scan so the previous poll's timer can't
   * fire mid-scan.  A subsequent `scheduleNext()` re-arms as normal.
   */
  function cancel() {
    clearTimeoutFn(timer);
    timer = null;
  }

  /**
   * Cancel any pending timer AND flag the scheduler as stopped so a
   * future `kickPoll` no-ops.  Combines the two calls needed at
   * shutdown / retire time into one atomic operation.
   */
  function stop() {
    stopped = true;
    clearTimeoutFn(timer);
    timer = null;
  }

  return {
    scheduleNext,
    kickPoll,
    cancel,
    stop,
    setPolling(v) {
      polling = v;
    },
    setStopped(v) {
      stopped = v;
    },
    peekPendingKick: () => pendingKick,
  };
}

/**
 * How long the bot waits before it looks at a position again, decided by
 * what the poll just finished did.
 *
 * After a rebalance, compound or cancel completed, it looks again almost
 * at once, so the dashboard shows the result. After a rebalance that
 * waited for gas, it looks again after the gas wait rather than the poll
 * interval, so a network too expensive to rebalance on is not asked again
 * every poll. Otherwise it waits the poll interval. Each poll decides
 * afresh from its own result, so a wait one poll chose never outlives it.
 *
 * @param {object} p
 * @param {boolean} p.actionCompleted  A rebalance, compound or cancel
 *   completed in the poll.
 * @param {boolean} p.gasDeferred      The poll's rebalance waited for gas.
 * @param {number} p.checkIntervalMs   The poll interval.
 * @param {number} p.gasDeferMs        The gas wait (gasDeferRetrySec).
 * @param {number} p.followUpMs        The quick look after an action.
 * @returns {number} Milliseconds until the next poll.
 */
function nextCheckDelayMs({
  actionCompleted,
  gasDeferred,
  checkIntervalMs,
  gasDeferMs,
  followUpMs,
}) {
  if (actionCompleted === true) return followUpMs;
  if (gasDeferred === true) return gasDeferMs;
  return checkIntervalMs;
}

module.exports = { createBotPollScheduler, nextCheckDelayMs };
