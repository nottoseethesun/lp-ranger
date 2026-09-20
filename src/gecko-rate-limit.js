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

const { log } = require("./log");
const {
  penaltyWaitMs,
  note429,
  _penaltyUntilMs,
  _resetForTest: _resetBackoff,
} = require("./price-source-backoff");
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

/*- The 429 penalty itself lives in `price-source-backoff.js`, keyed by
 *  source, because BOTH GeckoTerminal callers must share it and neither
 *  owns the other: `price-fetcher.js` fetches OHLCV, `gecko-pool-cache.js`
 *  fetches pool info, and a refusal of either is a refusal of the same
 *  service. This module keeps only the sliding window, which is
 *  GeckoTerminal's own published budget and belongs to GeckoTerminal. */
const SOURCE = "gecko";

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
  /*- Honour the shared 429 penalty. It is owned by
   *  price-source-backoff.js because the other GeckoTerminal caller
   *  raises it too, and a refusal there is a refusal of this service. */
  const penalty = penaltyWaitMs(SOURCE);
  if (penalty > 0) {
    log.info(
      `[gecko-rate-limit] 429 cool-down: waiting ${Math.ceil(penalty / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, penalty));
  }
  if (_callTimes.length >= _MAX_CALLS) {
    const waitMs = _callTimes[0] + _WINDOW_MS - now + 200;
    log.info(
      `[gecko-rate-limit] waiting ${Math.ceil(waitMs / 1000)}s (window full: ${_callTimes.length}/${_MAX_CALLS})`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  _callTimes.push(Date.now());
}

/**
 * Signal that GeckoTerminal returned a 429.
 *
 * Thin pass-through to the shared backoff, kept so callers that already
 * know this module need not learn a second one. The escalation across
 * consecutive refusals happens there — see `note429`.
 *
 * @param {number} coolDownMs  The delay the caller was going to wait.
 */
function noteGecko429(coolDownMs) {
  note429(SOURCE, coolDownMs);
}

/**
 * The instant the shared cool-down expires, epoch ms (tests /
 * diagnostics). The deadline as stored, not a remaining duration — a
 * reading taken after it has passed still shows that a 429 was recorded.
 */
function _getPenaltyUntilMs() {
  return _penaltyUntilMs(SOURCE);
}

/** Reset call timestamps + the shared backoff state (for testing). */
function _resetForTest() {
  _callTimes.length = 0;
  _resetBackoff();
}

module.exports = {
  geckoRateLimit,
  noteGecko429,
  _getPenaltyUntilMs,
  _resetForTest,
  _MAX_CALLS,
  _WINDOW_MS,
};
