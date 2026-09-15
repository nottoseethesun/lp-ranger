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

/**
 * Release the head of the queue and schedule the next drain.
 *
 * Re-arms itself only while waiters remain, rather than running a
 * permanent interval, so an idle process holds no timer at all.
 *
 * The timer is deliberately NOT `unref`'d: callers are awaiting these
 * resolvers, and an unref'd timer would let the process exit with
 * requests still queued, stranding those promises.  The cost is that
 * shutdown can wait out at most one interval.
 * @returns {void}
 */
function _drain() {
  _timer = null;
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
  if (_INTERVAL_MS <= 0) return Promise.resolve();

  const sinceLast = Date.now() - _lastReleaseMs;
  if (_queue.length === 0 && _timer === null && sinceLast >= _INTERVAL_MS) {
    _lastReleaseMs = Date.now();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    _queue.push(resolve);
    if (_timer === null) {
      /*- Wait out whatever remains of the interval since the last
       *  release, not a full interval — otherwise a request arriving
       *  just after one leaves would be penalised twice. */
      const wait = Math.max(0, _INTERVAL_MS - sinceLast);
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
}

module.exports = { acquire, getIntervalMs, queueLength, _resetForTests };
