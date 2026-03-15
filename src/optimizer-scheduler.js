/**
 * @file src/optimizer-scheduler.js
 * @module optimizerScheduler
 * @description
 * Manages the polling schedule for the LP Optimization Engine.
 *
 * Responsibilities
 * ────────────────
 * - Maintain an "enabled" toggle (on/off).
 * - When enabled, call the optimizer every `intervalMs` (default 10 minutes).
 * - Expose a `queryNow()` method for the manual "Query Now" UI button — this
 *   fires immediately regardless of the toggle state.
 * - Emit events (via a simple callback map) so the dashboard and bot process
 *   can react to new recommendations, errors, and state changes without
 *   coupling to this module's internals.
 * - Record the full history of the last N fetch results for the UI log.
 *
 * The scheduler is intentionally decoupled from both the HTTP client and the
 * applicator — it orchestrates them but does not contain their logic.
 *
 * @example
 * const scheduler = createOptimizerScheduler({
 *   client:    myOptimizerClient,
 *   onApply:   (result) => updateDashboard(result),
 *   onError:   (err)    => logError(err),
 *   request:   { poolAddress: '0x…', feeTier: 3000 },
 * });
 * scheduler.enable();          // start 10-min polling
 * scheduler.queryNow();        // fire once immediately (UI button)
 * scheduler.disable();         // stop polling
 * scheduler.getStatus();       // { enabled, lastFetchAt, lastResult, … }
 */

'use strict';

/** Default polling interval: 10 minutes. */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** How many fetch results to keep in the history ring buffer. */
const MAX_HISTORY = 50;

/**
 * @typedef {Object} SchedulerOptions
 * @property {object}   client           Optimizer client (from optimizer-client.js).
 * @property {object}   [applicator]     Applicator module (from optimizer-applicator.js).
 * @property {object}   [params]         Live BotParams object that the applicator mutates.
 * @property {object}   [request]        OptimizationRequest body to send to the engine.
 * @property {number}   [intervalMs]     Polling interval in ms. Default: 600 000 (10 min).
 * @property {Function} [onApply]        Called with ApplyResult each time params are updated.
 * @property {Function} [onFetch]        Called with FetchResult each time a response arrives.
 * @property {Function} [onError]        Called with an Error when a fetch fails.
 * @property {Function} [onStateChange]  Called with { enabled } when toggle changes.
 * @property {Function} [nowFn]          Injectable clock for testing. Default: Date.now.
 */

/**
 * @typedef {Object} SchedulerStatus
 * @property {boolean}      enabled         Whether auto-polling is active.
 * @property {number}       intervalMs      Current polling interval.
 * @property {string|null}  lastFetchAt     ISO timestamp of last fetch, or null.
 * @property {boolean|null} lastFetchOk     Success status of last fetch, or null.
 * @property {string|null}  lastError       Last error message, or null.
 * @property {number}       totalFetches    Total fetch attempts since scheduler was created.
 * @property {number}       successFetches  Total successful fetches.
 * @property {Array}        history         Ring buffer of last MAX_HISTORY fetch results.
 * @property {number|null}  nextFetchAt     Unix ms of next scheduled fetch, or null if disabled.
 */

/**
 * Factory that creates a scheduler instance.
 * @param {SchedulerOptions} opts
 * @returns {Object} scheduler handle
 */
function createOptimizerScheduler(opts = {}) {
  const client        = opts.client;
  const applicator    = opts.applicator   || null;
  const params        = opts.params       || null;
  const request       = opts.request      || {};
  const intervalMs    = opts.intervalMs   ?? DEFAULT_INTERVAL_MS;
  const onApply       = opts.onApply      || (() => {});
  const onFetch       = opts.onFetch      || (() => {});
  const onError       = opts.onError      || (() => {});
  const onStateChange = opts.onStateChange || (() => {});
  const nowFn         = opts.nowFn        || Date.now;

  if (!client || typeof client.fetchRecommendation !== 'function') {
    throw new Error('optimizerScheduler: opts.client must expose fetchRecommendation()');
  }

  // ── Internal state ────────────────────────────────────────────────────────

  let enabled      = false;
  let timer        = null;
  let nextFetchAt  = null;
  let lastFetchAt  = null;
  let lastFetchOk  = null;
  let lastError    = null;
  let totalFetches = 0;
  let successFetches = 0;

  /** @type {Array} */
  const history = [];

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Push an entry onto the history ring buffer. */
  function pushHistory(entry) {
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.pop();
  }

  /** Execute one fetch-and-apply cycle. */
  async function runCycle() {
    totalFetches += 1;
    lastFetchAt   = new Date(nowFn()).toISOString();

    let fetchResult;
    try {
      fetchResult = await client.fetchRecommendation(request);
    } catch (err) {
      lastFetchOk = false;
      lastError   = err.message;
      onError(err);
      pushHistory({ fetchedAt: lastFetchAt, ok: false, error: err.message });
      return;
    }

    onFetch(fetchResult);

    if (!fetchResult.ok) {
      lastFetchOk = false;
      lastError   = fetchResult.error;
      onError(new Error(fetchResult.error));
      pushHistory({ fetchedAt: lastFetchAt, ok: false, error: fetchResult.error,
                    httpStatus: fetchResult.httpStatus });
      return;
    }

    lastFetchOk   = true;
    lastError     = null;
    successFetches += 1;

    const rec = fetchResult.recommendation;
    let applyResult = null;

    if (applicator && params) {
      applyResult = applicator.applyRecommendation(params, rec);
      onApply(applyResult);
    }

    pushHistory({
      fetchedAt:   lastFetchAt,
      ok:          true,
      recommendation: rec,
      applyResult,
    });
  }

  /** Schedule the next poll tick and store the nextFetchAt timestamp. */
  function scheduleNext() {
    clearTimeout(timer);
    nextFetchAt = nowFn() + intervalMs;
    timer       = setTimeout(async () => {
      await runCycle();
      if (enabled) scheduleNext(); // re-arm only if still enabled
    }, intervalMs);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Enable auto-polling.  If already enabled, this is a no-op.
   * The first poll fires after one full interval.
   */
  function enable() {
    if (enabled) return;
    enabled = true;
    scheduleNext();
    onStateChange({ enabled: true });
  }

  /**
   * Disable auto-polling.  In-flight requests are not cancelled.
   */
  function disable() {
    if (!enabled) return;
    enabled     = false;
    nextFetchAt = null;
    clearTimeout(timer);
    timer       = null;
    onStateChange({ enabled: false });
  }

  /**
   * Toggle the enabled state.
   * @returns {boolean} The new enabled state.
   */
  function toggle() {
    if (enabled) { disable(); } else { enable(); }
    return enabled;
  }

  /**
   * Fire a single fetch-and-apply cycle immediately, regardless of toggle state.
   * Does not reset the auto-polling interval.
   * @returns {Promise<void>}
   */
  async function queryNow() {
    await runCycle();
  }

  /**
   * Return a snapshot of the current scheduler status.
   * @returns {SchedulerStatus}
   */
  function getStatus() {
    return {
      enabled,
      intervalMs,
      lastFetchAt,
      lastFetchOk,
      lastError,
      totalFetches,
      successFetches,
      history:     [...history],
      nextFetchAt: enabled ? nextFetchAt : null,
    };
  }

  /**
   * Update the OptimizationRequest body sent with each poll.
   * Useful when the active position changes.
   * @param {object} newRequest
   */
  function setRequest(newRequest) {
    Object.assign(request, newRequest);
  }

  /**
   * Change the polling interval. Takes effect on the next scheduled tick.
   * @param {number} newIntervalMs
   */
  function setInterval(newIntervalMs) {
    const ms = Math.max(1000, newIntervalMs); // enforce 1s minimum
    // Rearm the timer with the new interval if currently enabled
    if (enabled) {
      clearTimeout(timer);
      nextFetchAt = nowFn() + ms;
      timer = setTimeout(async () => {
        await runCycle();
        if (enabled) scheduleNext();
      }, ms);
    }
  }

  return { enable, disable, toggle, queryNow, getStatus, setRequest, setInterval };
}

// ── exports ───────────────────────────────────────────────────────────────────
module.exports = { createOptimizerScheduler, DEFAULT_INTERVAL_MS, MAX_HISTORY };
