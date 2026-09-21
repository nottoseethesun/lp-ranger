/**
 * @file src/rpc-request-manager.js
 * @module rpcRequestManager
 * @description
 * The Global RPC Request Manager: a single process-wide FIFO queue that
 * every outbound JSON-RPC request passes through, released one at a
 * time on a fixed schedule.
 *
 * **Why it is global rather than per-provider.**  Rate limits are
 * published per IP, not per endpoint object.  This process may hold
 * three providers (see `chains.json` → `rpc.urls`) and run a five-year
 * event scan while the bot polls, and every one of those shares the
 * same source address.  A per-provider or per-scan limiter would each
 * think itself well-behaved while the machine as a whole sailed past
 * the limit.  One queue, one budget.
 *
 * **Why it is agnostic to request content.**  The manager never looks
 * at the method, the params, or who is calling.  It holds waiters and a
 * timestamp, nothing more.  That is deliberate: a uniform release
 * schedule is the only thing that actually guarantees a rate, and every
 * exception — a fast path for reads, a priority lane for transactions —
 * is a hole through which the rate escapes.  If something needs to go
 * sooner, the answer is a shorter interval, not a bypass.
 *
 * **What it does not do.**  It is not a retry mechanism, not a failover
 * mechanism, and not a circuit breaker.  Those live in
 * `src/send-transaction.js` and `src/rpc-error-classifier.js`.  This
 * module only answers "may I send now?".
 *
 * Wired in by `buildProvider` (`src/bot-provider.js`), which wraps the
 * provider's `send()` — the single funnel through which ethers puts
 * every JSON-RPC call, reads and writes alike.
 *
 * Interval: `globalRPCRequestRateIntervalMS` in
 * `bot-config-defaults.json` (default 222 ms).  Read once at module
 * load, so a change needs a restart.  Zero disables pacing.
 */

"use strict";

const { readBotConfigDefaults } = require("./bot-config-defaults");

/*- Read once at load rather than per request.  This is plumbing an
 *  operator sets and forgets; re-reading the file on every RPC call
 *  would put a disk hit in front of each one, which is precisely the
 *  kind of cost this module exists to avoid. */
const _INTERVAL_MS = readBotConfigDefaults().globalRPCRequestRateIntervalMS;

/** Resolvers waiting for their turn, in arrival order. */
const _queue = [];

/** Epoch ms at which the most recent request was released. */
let _lastReleaseMs = 0;

/** Handle for the pending drain timer, or null when idle. */
let _timer = null;

/*- Epoch ms until which every request is held, or 0 when not halted.
 *
 *  Set by `src/send-transaction.js` when failover runs out of endpoints:
 *  with nothing left that answers, continuing to send is just hammering
 *  dead hosts. The halt is ABSOLUTE and content-agnostic, like the
 *  pacing it sits beside — a rebalance or compound waits it out with
 *  everything else. An exemption would be a hole the halt escapes
 *  through, and the one request that matters most during an outage is
 *  the one least likely to succeed. */
let _haltUntilMs = 0;

/*- When the current halt began, and the total of every halt that has
 *  already finished. Together these answer "how long has this process
 *  spent unable to reach a chain", which is not the same question as
 *  "how long has it been" — and a caller holding a deadline needs the
 *  difference. A transaction's confirm-or-cancel budget is time the
 *  CHAIN had to confirm it; an hour spent held here is time nobody
 *  asked the chain anything, and charging it to that budget cancels a
 *  transaction that was never given its chance. */
let _haltStartedMs = 0;
let _haltedBeforeCurrentMs = 0;

/** Milliseconds left on the halt; 0 when not halted. */
function _haltRemainingMs() {
  const remaining = _haltUntilMs - Date.now();
  return remaining > 0 ? remaining : 0;
}

/*- How much of the current halt has been served so far. Capped at the
 *  halt's own end, so a halt that finished an hour ago does not go on
 *  accruing. */
function _currentHaltServedMs() {
  if (_haltStartedMs === 0) return 0;
  const end = Math.min(Date.now(), _haltUntilMs);
  return end > _haltStartedMs ? end - _haltStartedMs : 0;
}

/**
 * Release the head of the queue and schedule the next drain.
 *
 * Re-arms itself only while waiters remain, rather than running a
 * permanent interval, so an idle process holds no timer at all.
 *
 * The timer is deliberately NOT `unref`'d: callers are awaiting these
 * resolvers, and an unref'd timer would let the process exit with
 * requests still queued, stranding those promises.  The cost is that it
 * holds the event loop open — for a pacing interval normally, and for
 * as long as an outage halt runs when one is engaged.  `server.js`
 * covers that: its shutdown handler force-exits three seconds after
 * SIGINT or SIGTERM regardless of what is still pending.
 * @returns {void}
 */
function _drain() {
  _timer = null;
  /*- Halted: release nobody and come back when it lifts. Checked here
   *  rather than only at `acquire` so requests already queued when the
   *  halt begins are held too — otherwise the backlog would drain
   *  straight into the dead endpoints the halt exists to stop calling. */
  const haltMs = _haltRemainingMs();
  if (haltMs > 0) {
    if (_queue.length > 0) _timer = setTimeout(_drain, haltMs);
    return;
  }
  const next = _queue.shift();
  if (next === undefined) return;
  _lastReleaseMs = Date.now();
  next();
  if (_queue.length > 0) _timer = setTimeout(_drain, _INTERVAL_MS);
}

/**
 * Wait for permission to send one JSON-RPC request.
 *
 * Resolves immediately when pacing is disabled, or when the queue is
 * empty and enough time has already passed since the last release —
 * so an idle bot polling every five minutes never pays a penalty.
 * Otherwise joins the queue and resolves when its turn comes.
 *
 * @returns {Promise<void>}  Resolves when the caller may send.
 */
function acquire() {
  /*- The halt outranks pacing, including the `0` that disables pacing:
   *  an operator who turned pacing off still wants the process to stop
   *  calling endpoints that have all stopped answering. Both fast paths
   *  below are therefore gated on it. */
  const haltMs = _haltRemainingMs();
  if (haltMs === 0 && _INTERVAL_MS <= 0) return Promise.resolve();

  const sinceLast = Date.now() - _lastReleaseMs;
  if (
    haltMs === 0 &&
    _queue.length === 0 &&
    _timer === null &&
    sinceLast >= _INTERVAL_MS
  ) {
    _lastReleaseMs = Date.now();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    _queue.push(resolve);
    if (_timer === null) {
      /*- Wait out whatever remains of the interval since the last
       *  release, not a full interval — otherwise a request arriving
       *  just after one leaves would be penalised twice. A halt, when
       *  one is running, outlasts both. */
      const wait = Math.max(0, _INTERVAL_MS - sinceLast, haltMs);
      _timer = setTimeout(_drain, wait);
    }
  });
}

/**
 * Configured interval, in milliseconds.  Exposed for logging and tests;
 * zero means pacing is disabled.
 * @returns {number}
 */
function getIntervalMs() {
  return _INTERVAL_MS;
}

/**
 * Hold every JSON-RPC request for `ms`, then resume at the normal pace.
 *
 * Called when RPC failover runs out of endpoints. Extends an existing
 * halt but never shortens one: two exhaustion reports in quick
 * succession describe the same outage, and the later one must not cut
 * the wait the first one started.
 *
 * No timer is touched here. A drain already scheduled will fire, see the
 * halt, and reschedule itself past it; an idle queue schedules past it
 * when the next request arrives. That leaves exactly one timer in play
 * however the halt lands.
 *
 * @param {number} ms  How long to hold requests. Ignored when not finite
 *   or not positive, so a misread config cannot wedge the process.
 * @returns {number} Epoch ms the halt now runs until; 0 if not halted.
 */
function halt(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return _haltUntilMs;
  const now = Date.now();
  /*- A fresh halt rather than an extension of a running one: bank what
   *  the last halt served before the clock restarts, so `totalHaltedMs`
   *  accumulates across outages instead of only reporting the latest. */
  if (now >= _haltUntilMs) {
    _haltedBeforeCurrentMs += _currentHaltServedMs();
    _haltStartedMs = now;
  }
  const until = now + ms;
  if (until > _haltUntilMs) _haltUntilMs = until;
  return _haltUntilMs;
}

/**
 * Milliseconds this process has spent with the queue halted, counting
 * every outage since start and including the one running now.
 *
 * For a caller holding a deadline that is meant to measure the chain's
 * opportunity rather than the wall clock: read it when the deadline
 * starts, read it again when checking, and subtract the difference.
 * `_waitOrSpeedUp` in `src/rebalancer-pools.js` is the caller this
 * exists for — without it, an outage pause eats the whole
 * confirm-or-cancel budget and the bot cancels a healthy transaction
 * seconds after the chain comes back.
 *
 * @returns {number}
 */
function totalHaltedMs() {
  return _haltedBeforeCurrentMs + _currentHaltServedMs();
}

/**
 * Milliseconds left on the current halt; 0 when requests flow normally.
 * Diagnostic, and the seam tests assert the halt through.
 * @returns {number}
 */
function haltRemainingMs() {
  return _haltRemainingMs();
}

/**
 * Number of requests currently waiting for a slot.  Diagnostic only.
 * @returns {number}
 */
function queueLength() {
  return _queue.length;
}

/**
 * Drop all queued waiters and clear pacing state.  TEST ONLY — resolves
 * every pending waiter so nothing hangs.
 * @returns {void}
 */
function _resetForTests() {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  while (_queue.length > 0) _queue.shift()();
  _lastReleaseMs = 0;
  _haltUntilMs = 0;
  _haltStartedMs = 0;
  _haltedBeforeCurrentMs = 0;
}

module.exports = {
  acquire,
  getIntervalMs,
  halt,
  haltRemainingMs,
  totalHaltedMs,
  queueLength,
  _resetForTests,
};
