/**
 * @file src/price-source-backoff.js
 * @module priceSourceBackoff
 * @description
 * One 429 backoff for every price source.
 *
 * A price source refuses with HTTP 429 when it has had enough. Two
 * things have to happen in response, and only one of them is a retry:
 *
 *   1. **This call waits and tries again.** A schedule of delays, which
 *      recovers a burst that has merely outrun the service's short-term
 *      counter.
 *   2. **Every OTHER call slows down too.** A per-call schedule cannot
 *      do this: it restarts at its first delay for each caller, so under
 *      a sustained refusal each one rediscovers the limit from scratch.
 *      Measured on a 132-epoch rebuild: 239 retries, 131 of which gave
 *      up with no price. A figure that gave up is not a slow figure, it
 *      is a missing one — and an epoch whose price is unknown is
 *      withheld from the Per-Day table entirely.
 *
 * The second is why this module holds state. `_streak` counts refusals
 * with no success between them, and the penalty doubles with it, so the
 * process as a whole backs off rather than 131 callers each waiting the
 * same insufficient ten seconds. Any success clears the streak, so an
 * isolated 429 costs nothing.
 *
 * State is keyed by SOURCE. GeckoTerminal refusing says nothing about
 * Moralis, and making one source's bad minute slow another would throw
 * away the fallback that exists to cover it.
 */

"use strict";

const { log } = require("./log");

/**
 * Delays (ms) between retries of a single refused call.
 *
 * Ten seconds first: three did not drain the burst counter once across
 * the run that produced these numbers. A minute last, which outlasts a
 * free-tier window. Worst case ~100s per call, paid only while the
 * service is genuinely refusing.
 * @type {number[]}
 */
let _delaysMs = [10_000, 30_000, 60_000];

/**
 * Ceiling on the escalating cross-call penalty (ms). Two minutes: long
 * enough to outlast a free-tier lockout, short enough that a rebuild
 * resumes on its own rather than needing a restart.
 */
const _MAX_PENALTY_MS = 120_000;

/** Per-source `{ streak, penaltyUntilMs }`. @type {Map<string, object>} */
const _state = new Map();

/** The record for one source, created on first use. */
function _for(source) {
  let s = _state.get(source);
  if (!s) {
    s = { streak: 0, penaltyUntilMs: 0 };
    _state.set(source, s);
  }
  return s;
}

/**
 * How long this source must wait before its next request, in ms.
 *
 * Consulted by a source's own rate limiter so the penalty applies to
 * every call, not only to the one that was refused.
 *
 * @param {string} source  Price-source name, e.g. "gecko".
 * @returns {number} Milliseconds to wait; 0 when there is no penalty.
 */
function penaltyWaitMs(source) {
  const remaining = _for(source).penaltyUntilMs - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * The absolute instant this source's penalty expires, in epoch ms.
 *
 * Distinct from `penaltyWaitMs`, which answers "how long must I wait"
 * and so floors at zero once the deadline passes. A caller comparing two
 * readings needs the deadline itself: a floored reading of an expired
 * penalty is indistinguishable from no penalty ever having been set, and
 * a deadline recomputed from a fresh `Date.now()` moves between two
 * consecutive reads.
 *
 * @param {string} source  Price-source name.
 * @returns {number} Epoch ms; 0 when no penalty has been recorded.
 */
function _penaltyUntilMs(source) {
  return _for(source).penaltyUntilMs;
}

/**
 * Record a refusal, and lengthen the penalty every source call observes.
 *
 * @param {string} source  Price-source name.
 * @param {number} baseMs  The delay this call was about to wait anyway.
 */
function note429(source, baseMs) {
  const s = _for(source);
  s.streak += 1;
  /*- Double per consecutive refusal, from the delay the caller already
   *  intended. The caller's schedule answers "this request was
   *  unlucky"; the streak answers "the service is refusing us", which
   *  is a different question and needs a different number. */
  const escalated = Math.max(0, baseMs) * 2 ** (s.streak - 1);
  const until = Date.now() + Math.min(escalated, _MAX_PENALTY_MS);
  if (until > s.penaltyUntilMs) s.penaltyUntilMs = until;
}

/**
 * Record a success, clearing both the streak and the standing penalty.
 *
 * The penalty goes too, not just the streak. A success is the service
 * answering, which is the only direct evidence available that it has
 * stopped refusing — holding the remaining cool-down after that makes
 * every later call wait out a restriction that has already lifted. On a
 * capped two-minute penalty that is up to two minutes of a rebuild
 * spent waiting for nothing.
 *
 * Clearing the streak alone would also leave the penalty standing while
 * the streak restarts from one, so the next refusal computes a small
 * penalty, finds the old larger one still in place, and discards its
 * own — the escalation would then only ever ratchet upward.
 *
 * @param {string} source  Price-source name.
 */
function noteOk(source) {
  const s = _for(source);
  s.streak = 0;
  s.penaltyUntilMs = 0;
}

/**
 * Run a request, retrying it while the source answers 429.
 *
 * `fetchOnce` must resolve to an object carrying `status`; anything
 * other than 429 is returned to the caller untouched, including the
 * failures this module has no opinion about.
 *
 * @param {object} o
 * @param {string} o.source     Price-source name, e.g. "gecko".
 * @param {string} o.label      What is being fetched, for the log.
 * @param {() => Promise<{status: number}>} o.fetchOnce
 * @returns {Promise<{status: number}>} The final response.
 */
async function retryOn429({ source, label, fetchOnce }) {
  let res = await fetchOnce();
  for (let i = 0; res.status === 429 && i < _delaysMs.length; i++) {
    const delay = _delaysMs[i];
    note429(source, delay);
    log.warn(
      "[price-backoff] %s %s 429 — retry %d/%d in %ds",
      source,
      label,
      i + 1,
      _delaysMs.length,
      Math.round(delay / 1000),
    );
    await new Promise((r) => setTimeout(r, delay));
    res = await fetchOnce();
  }
  if (res.status === 429)
    log.warn(
      "[price-backoff] %s %s still refusing after %d retries — giving up",
      source,
      label,
      _delaysMs.length,
    );
  else noteOk(source);
  return res;
}

/** Override the retry schedule (tests only). */
function _setDelays(delays) {
  _delaysMs = delays;
}

/** The current schedule (tests / diagnostics). */
function _getDelays() {
  return [..._delaysMs];
}

/** Reset all per-source state (tests only). */
function _resetForTest() {
  _state.clear();
}

module.exports = {
  retryOn429,
  penaltyWaitMs,
  note429,
  noteOk,
  _penaltyUntilMs,
  _setDelays,
  _getDelays,
  _resetForTest,
  _MAX_PENALTY_MS,
};
