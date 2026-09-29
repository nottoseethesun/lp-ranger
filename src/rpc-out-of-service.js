/**
 * @file src/rpc-out-of-service.js
 * @module rpcOutOfService
 * @description
 * Whether an RPC endpoint is currently out of service.
 *
 * Every RPC outcome in the process reports here — reads, writes, gas
 * estimates, the pool-state walk, the wallet-balance walk, successes as
 * well as failures. `decideIfCurrentRPCIsOutOfService` answers from the
 * share of failures inside a recent window, so reporting a failure is
 * not the same act as deciding one. That separation is the point:
 * a reader that legitimately fails often can report honestly without
 * retiring an endpoint on everyone's behalf, and an endpoint is retired
 * only when it is failing most of what it is asked.
 *
 * Successes are counted for the same reason a percentage needs a
 * denominator. Ten failures mean one thing among twelve requests and
 * another among a thousand.
 *
 * Outcomes are tallied per second rather than kept one by one, which
 * is what keeps this bounded: a window holds at most one small record
 * per second per endpoint however fast requests arrive, and recording
 * one costs the same at ten requests a second as at ten thousand. One
 * record per request would grow both with the rate, and pacing can be
 * turned off against a local node. The cost is that the window's edge
 * moves in whole seconds, which a five-minute health judgement does
 * not notice.
 *
 * State is per endpoint URL. One endpoint refusing says nothing about
 * the others, and the whole purpose of the list is that they fail
 * independently.
 */

"use strict";

const { readBotConfigDefaults } = require("./bot-config-defaults");

/*- Read once at load, as `rpc-request-manager.js` reads its pacing
 *  interval: `readBotConfigDefaults()` re-reads and merges the JSON
 *  from disk on every call, and these two are consulted on paths that
 *  run per request. The group they belong to is documented as needing
 *  a restart to take effect, which is what makes reading once correct
 *  rather than merely cheap. */
const _WINDOW_SEC = readBotConfigDefaults().rpcFailoverRateDurationMinutes * 60;
const _THRESHOLD_PCT = readBotConfigDefaults().rpcFailoverRatePercentage;

/**
 * Per-URL tallies: `Map<url, Map<secondBucket, {ok, fail}>>`.
 *
 * Reassigned rather than mutated when seconds age out, so the surviving
 * tallies are copied into a fresh map and the old one is dropped whole.
 * Deleting keys in place leaves a Map's backing store at whatever size
 * it grew to, and this one is written to on every request for the life
 * of the process. Rebuilding also drops endpoints that have gone quiet
 * — an endpoint removed from the operator's list would otherwise keep
 * its last window forever, since nothing would touch it again to prune
 * it.
 */
let _tallies = new Map();

/**
 * Hard ceiling on seconds kept per endpoint: one hour, which is the
 * longest window the config can ask for.
 *
 * The clamp on `rpcFailoverRateDurationMinutes` already bounds this in
 * the ordinary case. The ceiling is here for the case the clamp cannot
 * cover: a system clock that jumps forward writes a tally far in the
 * future, and a future second never ages out of a window that ends at
 * the present. Keeping only the newest hour's worth bounds that too.
 */
const _MAX_SECONDS_KEPT = 60 * 60;

/** The second an instant falls in. */
function _nowBucket() {
  return Math.floor(Date.now() / 1000);
}

/**
 * The seconds of one endpoint's tallies that are still in the window,
 * newest-first order preserved, capped at `_MAX_SECONDS_KEPT`.
 *
 * @param {Map<number, object>} bySecond
 * @param {number} oldest  The last second that has aged out.
 * @returns {Map<number, object>} A new map; the input is not mutated.
 */
function _survivors(bySecond, oldest) {
  const live = [...bySecond].filter(([second]) => second > oldest);
  const capped =
    live.length > _MAX_SECONDS_KEPT
      ? live.sort((a, b) => b[0] - a[0]).slice(0, _MAX_SECONDS_KEPT)
      : live;
  return new Map(capped);
}

/**
 * Drop every second that has aged out, across every endpoint, by
 * building a fresh store and replacing the old one.
 *
 * Runs once per second at most — see `_forRecording`.
 * @returns {void}
 */
function _pruneAll() {
  const oldest = _nowBucket() - _WINDOW_SEC;
  const rebuilt = new Map();
  for (const [url, bySecond] of _tallies) {
    const kept = _survivors(bySecond, oldest);
    /*- An endpoint with nothing left in the window is left out, which
     *  is what stops a removed endpoint holding its last window for
     *  the life of the process. */
    if (kept.size > 0) rebuilt.set(url, kept);
  }
  _tallies = rebuilt;
}

/**
 * This endpoint's tallies with the aged-out seconds dropped.
 *
 * Pruning on access rather than on a timer means there is no background
 * work to cancel and nothing to miss: an endpoint nothing asks about
 * holds stale seconds until it is asked, and answers correctly then.
 *
 * @param {string} url
 * @returns {Map<number, object>} The surviving seconds for `url`.
 */
function _live(url) {
  _pruneAll();
  let bySecond = _tallies.get(url);
  if (bySecond === undefined) {
    bySecond = new Map();
    _tallies.set(url, bySecond);
  }
  return bySecond;
}

/**
 * This endpoint's tallies without pruning, for the recording path.
 *
 * Recording happens once per request and pruning changes nothing until
 * the clock crosses a second, so the scan belongs where a new second
 * starts rather than on every call. At ten thousand requests a second
 * — pacing off, against a local node — the difference is a scan of the
 * whole window per request against one per second.
 *
 * @param {string} url
 * @returns {Map<number, object>}
 */
function _forRecording(url) {
  const bySecond = _tallies.get(url);
  return bySecond === undefined ? _live(url) : bySecond;
}

/**
 * Record one RPC outcome against the endpoint that served it.
 *
 * @param {string} url  The endpoint the request went to.
 * @param {boolean} ok  Whether it answered.
 * @returns {void}
 */
function noteRpcResult(url, ok) {
  if (typeof url !== "string" || url === "") return;
  const second = _nowBucket();
  let bySecond = _forRecording(url);
  let tally = bySecond.get(second);
  if (tally === undefined) {
    /*- A second that has not been written to is the clock having moved
     *  on, which is the only moment anything can have aged out. */
    bySecond = _live(url);
    tally = { ok: 0, fail: 0 };
    bySecond.set(second, tally);
  }
  if (ok === true) tally.ok += 1;
  else tally.fail += 1;
}

/**
 * Is this endpoint failing more than the configured share of what it is
 * asked?
 *
 * No outcomes in the window means no, not yes: an endpoint nobody has
 * asked recently has not been shown to be anything, and answering yes
 * would retire endpoints for being idle.
 *
 * @param {string} url  The endpoint to judge.
 * @returns {boolean}
 */
function decideIfCurrentRPCIsOutOfService(url) {
  let ok = 0;
  let fail = 0;
  for (const tally of _live(url).values()) {
    ok += tally.ok;
    fail += tally.fail;
  }
  if (ok + fail === 0) return false;
  const pct = (fail / (ok + fail)) * 100;
  return pct > _THRESHOLD_PCT;
}

/**
 * Forget everything recorded for one endpoint.
 *
 * Called once selection has moved off it, so that returning to it later
 * judges it on what it does then rather than on the window that
 * retired it.
 *
 * @param {string} url
 * @returns {void}
 */
function clearRpcSamples(url) {
  _tallies.delete(url);
}

/** How many seconds are held for one endpoint (tests only). */
function _secondsKept(url) {
  const bySecond = _tallies.get(url);
  return bySecond === undefined ? 0 : bySecond.size;
}

/** Drop all recorded state (tests only). */
function _resetForTests() {
  _tallies = new Map();
}

module.exports = {
  noteRpcResult,
  decideIfCurrentRPCIsOutOfService,
  clearRpcSamples,
  _MAX_SECONDS_KEPT,
  _secondsKept,
  _resetForTests,
};
