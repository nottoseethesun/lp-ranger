/**
 * @file src/gecko-rate-limit.js
 * @module geckoRateLimit
 * @description
 * Shared sliding-window rate limiter for ALL GeckoTerminal HTTP calls.
 *
 * GeckoTerminal's free public API enforces ~30 requests per 60-second window
 * across all endpoints (OHLCV, pool info, networks, etc.). This module keeps
 * a single global queue so every GeckoTerminal call (made by `price-fetcher.js`,
 * `gecko-pool-cache.js`, or any future caller) shares the same budget. We
 * deliberately stay below the hard limit to leave headroom for transient bursts.
 *
 * The limiter uses a sliding window: it tracks the timestamps of the last N
 * calls and waits until the oldest one falls outside the 60-second window
 * before allowing a new call to proceed.
 *
 * Lives in its own module to avoid a circular dependency between
 * `price-fetcher.js` and `gecko-pool-cache.js` (both need rate limiting and
 * one already requires the other).
 */

"use strict";

/** @type {number[]} Timestamps (ms) of recent GeckoTerminal API calls. */
const _callTimes = [];

/**
 * Max calls per window — leave generous margin below the 30/min hard limit.
 * The lower budget (was 25) protects against cross-restart bursts: a restart
 * clears our in-process counter but GeckoTerminal still sees the last minute
 * of calls from the previous process.
 */
const _MAX_CALLS = 20;

/** Sliding window length in milliseconds (60 seconds). */
const _WINDOW_MS = 60_000;

/**
 * Extra cool-down (ms) imposed when GeckoTerminal returns a 429 response. This
 * pushes the window forward so subsequent calls in the same burst pause rather
 * than immediately re-firing and collecting more 429s. Caller signals this via
 * `noteGecko429()`.
 * @type {number}
 */
let _penaltyUntilMs = 0;

/**
 * Wait if necessary to stay within GeckoTerminal's rate limit.
 * Call this immediately before any GeckoTerminal HTTP request.
 *
 * @returns {Promise<void>}  Resolves once it is safe to make the call.
 */
async function geckoRateLimit() {
  const now = Date.now();
  // Drop expired timestamps from the front of the window.
  while (_callTimes.length > 0 && _callTimes[0] < now - _WINDOW_MS) {
    _callTimes.shift();
  }
  // Honor any server-imposed cool-down from a previous 429 signal.
  if (_penaltyUntilMs > now) {
    const waitMs = _penaltyUntilMs - now;
    console.log(
      `[gecko-rate-limit] 429 cool-down: waiting ${Math.ceil(waitMs / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (_callTimes.length >= _MAX_CALLS) {
    const waitMs = _callTimes[0] + _WINDOW_MS - now + 200;
    console.log(
      `[gecko-rate-limit] waiting ${Math.ceil(waitMs / 1000)}s (window full: ${_callTimes.length}/${_MAX_CALLS})`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  _callTimes.push(Date.now());
}

/**
 * Signal that GeckoTerminal returned a 429. The next call via
 * `geckoRateLimit()` will sleep for `coolDownMs` before firing. Any pending
 * in-flight callers in the same burst will also wait. This is shared state —
 * all callers across modules see the penalty.
 *
 * @param {number} coolDownMs  How long to delay the next call (milliseconds).
 */
function noteGecko429(coolDownMs) {
  const until = Date.now() + Math.max(0, coolDownMs);
  if (until > _penaltyUntilMs) _penaltyUntilMs = until;
}

/** Current penalty timestamp (for tests / diagnostics). */
function _getPenaltyUntilMs() {
  return _penaltyUntilMs;
}

/** Reset call timestamps + penalty (for testing). */
function _resetForTest() {
  _callTimes.length = 0;
  _penaltyUntilMs = 0;
}

module.exports = {
  geckoRateLimit,
  noteGecko429,
  _getPenaltyUntilMs,
  _resetForTest,
  _MAX_CALLS,
  _WINDOW_MS,
};
