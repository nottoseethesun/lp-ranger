/**
 * @file throttle.js
 * @module throttle
 * @description
 * Manages rebalance timing enforcement for the 9mm v3 position manager bot.
 *
 * Rules enforced:
 *  1. A minimum interval must elapse between any two rebalances.
 *  2. A daily maximum caps total rebalances per 24-hour window.
 *  3. **Doubling mode**: if `TRIGGER_COUNT` rebalances occur within
 *     `TRIGGER_WINDOW_MULTIPLE` times the minimum interval, every
 *     subsequent rebalance in the same day must wait twice as long as the
 *     previous wait.  The multiplier compounds — 10m → 20m → 40m → 80m…
 *  4. Doubling mode clears automatically if no rebalance trigger fires within
 *     `QUIET_WINDOW_MULTIPLE` times the current (already-doubled) wait after
 *     the last rebalance, or at the daily midnight reset.
 *
 * The three doubling numbers live in bot-config-defaults.json →
 * `throttleDoubling`, with an operator's override applied; the
 * dashboard is sent the same numbers to show the rule it enforces.
 *
 * @example
 * import { createThrottle } from './throttle.js';
 * const t = createThrottle({ minIntervalMs: 600_000, dailyMax: 20 });
 * const check = t.canRebalance();
 * if (check.allowed) t.recordRebalance();
 */

"use strict";

const { readBotConfigDefaults } = require("./bot-config-defaults");

/*-
 *  The bot defaults, read once at module init for doubling mode's rule
 *  below: the shipped file with an operator's override on top. The
 *  dashboard's trigger-window label and help are sent these same
 *  numbers, so they describe the rule the bot enforces.
 */
const _DEFAULTS = readBotConfigDefaults();

/*-
 *  Doubling mode's three numbers: how many rebalances inside the trigger
 *  window switch it on, the window as a multiple of the minimum
 *  interval, and the quiet spell that clears it as a multiple of the
 *  current wait.
 */
const {
  triggerCount: TRIGGER_COUNT,
  triggerWindowMultiple: TRIGGER_WINDOW_MULTIPLE,
  quietWindowMultiple: QUIET_WINDOW_MULTIPLE,
} = _DEFAULTS.throttleDoubling;

/**
 * @typedef {Object} ThrottleOptions
 * @property {number} minIntervalMs  Minimum ms between rebalances. The bot
 *   passes `MIN_REBALANCE_INTERVAL_MIN`, which startup has checked.
 * @property {number} dailyMax       Maximum rebalances per day. The bot
 *   passes `MAX_REBALANCES_PER_DAY`, which startup has checked.
 * @property {Function} [nowFn]               Injectable clock — returns current ms timestamp.
 *                                            Defaults to `Date.now`. Used for testing.
 */

/**
 * @typedef {Object} CanRebalanceResult
 * @property {boolean} allowed            True if a rebalance may proceed right now.
 * @property {number}  msUntilAllowed     Milliseconds until next rebalance is permitted (0 if allowed).
 * @property {'ok'|'min_interval'|'doubling'|'daily_limit'} reason  Why the decision was made.
 */

/**
 * @typedef {Object} ThrottleState
 * @property {number}   minIntervalMs      Current base minimum interval in ms.
 * @property {number}   dailyMax           Maximum rebalances allowed per day.
 * @property {number}   dailyCount         Rebalances completed today.
 * @property {number}   lastRebTime        Timestamp of the most recent rebalance (0 = never).
 * @property {number[]} rebTimestamps      Timestamps of all rebalances in the current day.
 * @property {boolean}  doublingActive     Whether doubling mode is currently engaged.
 * @property {number}   doublingCount      How many doublings have been applied.
 * @property {number}   currentWaitMs      The effective wait required right now (base or doubled).
 * @property {number}   dailyResetAt       Unix ms timestamp of the next midnight reset.
 */

/**
 * @typedef {Object} ThrottleHandle
 * @property {function(): CanRebalanceResult} canRebalance   Check if a rebalance is permitted.
 * @property {function(): void}               recordRebalance Record that a rebalance just ran.
 * @property {function(): void}               tick            Call on each bot poll cycle to
 *                                                            handle resets and expiry checks.
 * @property {function(): ThrottleState}      getState        Return a snapshot of current state.
 * @property {function(Partial<ThrottleOptions>): void} configure  Update options live.
 */

/**
 * Compute the Unix ms timestamp for the next midnight UTC.
 * @param {Function} nowFn - Clock function returning current ms timestamp.
 * @returns {number}
 */
function nextMidnight(nowFn) {
  const d = new Date(nowFn());
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() + 86_400_000;
}

/**
 * Factory that creates a throttle controller instance.
 * @param {ThrottleOptions} opts
 * @returns {ThrottleHandle}
 */
function createThrottle(opts) {
  const nowFn = opts.nowFn || Date.now;
  const minIntervalMs = opts.minIntervalMs;

  /** @type {ThrottleState} */
  const state = {
    minIntervalMs,
    dailyMax: opts.dailyMax,
    dailyCount: 0,
    lastRebTime: 0,
    rebTimestamps: [],
    doublingActive: false,
    doublingCount: 0,
    currentWaitMs: minIntervalMs,
    dailyResetAt: nextMidnight(nowFn),
  };

  // ─── private helpers ────────────────────────────────────────────────────────

  /** Reset all daily counters and doubling state. */
  function _resetDaily() {
    state.dailyCount = 0;
    state.rebTimestamps = [];
    state.doublingActive = false;
    state.doublingCount = 0;
    state.currentWaitMs = state.minIntervalMs;
    state.dailyResetAt = nextMidnight(nowFn);
  }

  /**
   * Determine whether doubling mode should be activated or advanced.
   * Called immediately after a rebalance is recorded.
   * @returns {boolean} True if doubling was newly activated this call.
   */
  function _evaluateDoubling() {
    const now = nowFn();
    const triggerWindow = TRIGGER_WINDOW_MULTIPLE * state.minIntervalMs;
    const recent = state.rebTimestamps.filter((t) => now - t <= triggerWindow);

    if (!state.doublingActive && recent.length >= TRIGGER_COUNT) {
      state.doublingActive = true;
      state.doublingCount = 1;
      state.currentWaitMs = state.minIntervalMs * 2;
      return true;
    }

    if (state.doublingActive) {
      state.doublingCount += 1;
      state.currentWaitMs = state.currentWaitMs * 2;
    }
    return false;
  }

  /**
   * Clear doubling mode if enough quiet time has passed since the last rebalance.
   * "Quiet time" = `QUIET_WINDOW_MULTIPLE` times the current (already-doubled) wait.
   */
  function _maybeExpireDoubling() {
    if (!state.doublingActive) return;
    const now = nowFn();
    const expiryWindow = QUIET_WINDOW_MULTIPLE * state.currentWaitMs;
    if (state.lastRebTime > 0 && now - state.lastRebTime > expiryWindow) {
      state.doublingActive = false;
      state.doublingCount = 0;
      state.currentWaitMs = state.minIntervalMs;
    }
  }

  // ─── public API ─────────────────────────────────────────────────────────────

  /**
   * Determine whether a rebalance is permitted right now.
   * Does NOT modify state.
   * @returns {CanRebalanceResult}
   */
  function canRebalance() {
    const now = nowFn();

    if (state.dailyCount >= state.dailyMax) {
      return {
        allowed: false,
        msUntilAllowed: Math.max(0, state.dailyResetAt - now),
        reason: "daily_limit",
      };
    }

    const effectiveWait = state.doublingActive
      ? state.currentWaitMs
      : state.minIntervalMs;

    if (state.lastRebTime > 0) {
      const elapsed = now - state.lastRebTime;
      if (elapsed < effectiveWait) {
        return {
          allowed: false,
          msUntilAllowed: effectiveWait - elapsed,
          reason: state.doublingActive ? "doubling" : "min_interval",
        };
      }
    }

    return { allowed: true, msUntilAllowed: 0, reason: "ok" };
  }

  /**
   * Record that a rebalance just completed.
   * Updates counters, timestamps, and evaluates doubling.
   * @returns {{ newlyDoubled: boolean }}
   */
  function recordRebalance() {
    const now = nowFn();
    state.lastRebTime = now;
    state.dailyCount += 1;
    state.rebTimestamps.push(now);
    const newlyDoubled = _evaluateDoubling();
    return { newlyDoubled };
  }

  /**
   * Must be called each bot poll cycle.
   * Handles midnight resets and doubling expiry.
   * @returns {{ didReset: boolean, didClearDoubling: boolean }}
   */
  function tick() {
    const now = nowFn();
    let didReset = false;
    let didClearDbl = false;

    if (now >= state.dailyResetAt) {
      _resetDaily();
      didReset = true;
    }

    const wasDoubling = state.doublingActive;
    _maybeExpireDoubling();
    if (wasDoubling && !state.doublingActive) didClearDbl = true;

    return { didReset, didClearDoubling: didClearDbl };
  }

  /**
   * Return a shallow snapshot of current throttle state.
   * @returns {ThrottleState}
   */
  function getState() {
    return { ...state, rebTimestamps: [...state.rebTimestamps] };
  }

  /**
   * Update configuration options live (e.g. from UI changes).
   * @param {Partial<ThrottleOptions>} newOpts
   */
  function configure(newOpts) {
    if (newOpts.minIntervalMs !== null && newOpts.minIntervalMs !== undefined) {
      state.minIntervalMs = newOpts.minIntervalMs;
      if (!state.doublingActive) state.currentWaitMs = state.minIntervalMs;
    }
    if (newOpts.dailyMax !== null && newOpts.dailyMax !== undefined)
      state.dailyMax = newOpts.dailyMax;
  }

  /**
   * Rehydrate dailyCount from historical events (e.g. after bot restart).
   * @param {number} count  Number of rebalances in the current daily window.
   */
  function rehydrate(count) {
    state.dailyCount = count;
  }

  return {
    canRebalance,
    recordRebalance,
    tick,
    getState,
    configure,
    rehydrate,
  };
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = { createThrottle, nextMidnight };
