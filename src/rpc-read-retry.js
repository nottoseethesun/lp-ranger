"use strict";

/**
 * @file src/rpc-read-retry.js
 * @module rpc-read-retry
 *
 * The one retry loop for a read that an endpoint refused.
 *
 * Extracted from `src/send-transaction.js` rather than living beside the
 * failover state it drives, for two reasons: that file sits on the
 * 500-line cap, and the dependencies arrive by injection here, so the
 * loop can be exercised directly without booting the transaction layer
 * or standing up providers.
 *
 * **Injection is what lets one loop serve two very different callers.**
 * The loop never decides which endpoint to use; it asks `current()` and
 * reports failures to `failover()`. A caller that reads through the
 * managed read provider passes the process-wide selection, so its
 * retries follow whatever failover has chosen. A caller that must try
 * every endpoint regardless — `getPoolState`, whose answer the bot
 * cannot poll without — passes a cursor of its own instead, and so
 * walks the list without moving global selection for everyone else.
 * Both get the same reporting, the same recovery line and the same
 * accounting.
 *
 * **The unit of retry is a function, not a provider method.** One pool
 * state is five reads that have to agree with each other, so retrying
 * them individually could pair a price from one endpoint with a pool
 * address from another. `run(provider)` therefore receives the endpoint
 * and does whatever it needs with it, and `label` is only what the logs
 * call that work.
 *
 * **Why the default is never to give up.** The alternative is dropping
 * the read. For a chunked log scan a dropped read is a block window
 * that is never read, which leaves the pool's rebalance chain short a
 * rebalance — and epoch count, Lifetime and Cumulative P&L and IL/G are
 * then all computed over an incomplete history and rendered as settled
 * fact. A stalled scan is visible in the log and recoverable by
 * waiting; a silently short one is neither. These outages almost always
 * heal. A caller for whom a bounded wait matters more than an eventual
 * answer sets `maxAttempts` and an `onExhausted` that throws — which is
 * how pool state keeps reporting `pool-info-unavailable` to the
 * dashboard rather than hanging a Manage click for ever.
 *
 * **Why there is no backoff by default.** Every provider is built by
 * `bot-provider.buildProvider`, which funnels each call through the
 * global pacing queue (`src/rpc-request-manager.js`), so attempts are
 * already spaced by `globalRPCRequestRateIntervalMS` and this loop
 * cannot spin. A delay here would be a second rate mechanism competing
 * with the one that owns the schedule — the very "hole through which the
 * rate escapes" that module warns against. `delayMs` exists for the
 * caller that wants a blip time to clear before asking the SAME
 * endpoint again, and applies only then: moving to a different endpoint
 * is not a reason to wait.
 *
 * **Why a success is logged, having said nothing on the way in.** Each
 * failed attempt writes a line, and a run of them that simply stops is
 * ambiguous: a read served by the next endpoint and a read abandoned
 * altogether both end in silence. Whoever reads the log is then left
 * deciding whether the bot is working. So a retry that eventually
 * succeeds closes its own run with one line, naming the endpoint that
 * served it and whether that endpoint is the one that had been failing.
 * It fires only when a failure was logged first — an attempt that
 * succeeds immediately has nothing to resolve, and announcing it would
 * bury the runs that matter.
 */

const { log } = require("./log");

/**
 * Close out a run of logged retry failures with a single line.
 *
 * Reports how many attempts failed and which endpoint finally answered.
 * Naming both that endpoint and the last one to fail is what makes the
 * line worth printing: the two being different says another endpoint
 * served the read, while the two being equal says the one that had been
 * failing recovered on its own. Those are the two outcomes a reader
 * cannot otherwise tell apart, and they call for different follow-up.
 *
 * Both urls are optional because `urlOf` is injected and a caller
 * without an endpoint list resolves neither; the line then carries the
 * count alone, which still answers whether the read completed.
 *
 * @param {string} tag           Log prefix identifying the caller.
 * @param {string} label         What the retried work is called.
 * @param {number} failures      Attempts that failed before this one.
 * @param {?string} servedBy     Endpoint that answered, if known.
 * @param {?string} lastFailed   Endpoint that failed last, if known.
 */
function _logRecovery(tag, label, failures, servedBy, lastFailed) {
  let where = "";
  if (servedBy && lastFailed && servedBy !== lastFailed) {
    where = ` — served by ${servedBy} (failed over from ${lastFailed})`;
  } else if (servedBy) {
    where = ` — ${servedBy} recovered, no failover`;
  }
  log.info(
    "[%s] read ok on %s after %d failed attempt(s)%s",
    tag,
    label,
    failures,
    where,
  );
}

/**
 * Log one attempt's failure, naming the endpoint and the budget left.
 *
 * The budget appears only when there is one: an ordinary read retries
 * for ever, and `#3/∞` would be noise. The endpoint appears only when
 * it resolves, which is every time but the window described on
 * `urlOf`.
 *
 * @param {string} tag         Log prefix identifying the caller.
 * @param {string} label       What the retried work is called.
 * @param {number} attempt     Which attempt just failed, from one.
 * @param {number} maxAttempts Budget, possibly `Infinity`.
 * @param {?string} url        Endpoint that failed, if known.
 * @param {Error} err          The failure.
 */
function _logAttemptFailure(tag, label, attempt, maxAttempts, url, err) {
  const budget = Number.isFinite(maxAttempts) ? `/${maxAttempts}` : "";
  const where = url ? ` rpc=${url}` : "";
  log.warn(
    "[%s] read retry #%d%s on %s failed:%s %s",
    tag,
    attempt,
    budget,
    label,
    where,
    err.message,
  );
}

/**
 * Report the failure in hand, if there is one, and say whether
 * selection moved.
 *
 * A caller that arrived having already failed names the provider it saw
 * fail, so it reports on its first attempt. One that has attempted
 * nothing yet must not: it would step selection for a read that then
 * succeeds, and it would step it unnamed, which skips the guard in
 * `failoverToNextRPC` that keeps concurrent callers from each advancing
 * the list once.
 *
 * @param {(failed?: object) => boolean} failover  Reporting function.
 * @param {?object} failed  Provider whose failure is being reported.
 * @returns {boolean}  Whether selection moved.
 */
function _report(failover, failed) {
  if (failed === undefined || failed === null) return false;
  return failover(failed);
}

/**
 * Retry a failed read across endpoints until one serves it.
 *
 * @param {object} opts
 * @param {string} opts.label         What the logs call this work.
 * @param {(provider: object) => Promise<*>} opts.run  Perform the read
 *   against the given endpoint. Receives the provider so a composite
 *   read stays on one endpoint for all of its parts.
 * @param {Error} opts.err            The failure that triggered the retry.
 * @param {(e: unknown) => boolean} opts.isFailoverable  True when the
 *   error shape indicates the endpoint is at fault, not the request.
 * @param {(failed?: object) => boolean} opts.failover  Report that an
 *   endpoint failed. Returns whether selection actually moved, which is
 *   also what decides whether `delayMs` applies.
 * @param {() => object} opts.current    The endpoint to use now.
 * @param {string} [opts.tag]         Log prefix. Defaults to `send-tx`.
 * @param {(provider: object, ok: boolean) => void} [opts.note]  Record
 *   one attempt's outcome against the endpoint that served it. During an
 *   outage these attempts are most of the traffic, so a rate judged
 *   without them would be judged on a single sample.
 * @param {(provider: object) => ?string} [opts.urlOf]  Resolve a
 *   provider to its endpoint url, for the log lines. May answer `null`
 *   for one attempt if the operator re-points the endpoint list while a
 *   retry is in flight, since the provider in hand is then no longer
 *   one of the list's: that attempt's outcome is dropped from the rate
 *   and its log line carries no endpoint. Both self-correct on the next
 *   attempt, which resolves `current()` afresh, so this is left to pass
 *   rather than guarded against.
 * @param {number} [opts.maxAttempts]  Attempts before giving up.
 *   Unbounded by default; see the file header.
 * @param {(attempts: number, lastErr: Error) => never} [opts.onExhausted]
 *   Raise the caller's own error once `maxAttempts` is spent. Defaults
 *   to rethrowing the last failure.
 * @param {number} [opts.delayMs]     Wait before asking the SAME
 *   endpoint again. Not applied when selection moved.
 * @param {object} [opts.failedProvider] The provider whose failure is
 *   `err`. Naming it keeps concurrent failures on one endpoint from
 *   advancing the list once each.
 * @returns {Promise<*>}  The first successful result.
 * @throws  `err` when it is not failover-eligible, any non-failoverable
 *   error raised by a later attempt, or whatever `onExhausted` raises.
 */
async function retryRead({
  label,
  run,
  err,
  isFailoverable,
  failover,
  current,
  tag = "send-tx",
  /*- Defaulted so a caller that has no decider to report to — a test
   *  driving the loop in isolation — does not crash on a missing
   *  function. */
  note = () => {},
  urlOf = () => null,
  maxAttempts = Infinity,
  onExhausted = (attempts, lastErr) => {
    throw lastErr;
  },
  delayMs = 0,
  failedProvider,
}) {
  if (!isFailoverable(err)) throw err;
  /*- Which endpoint the failure being reported came from.  It changes
   *  every iteration, because each attempt runs against whichever
   *  endpoint selection had moved to by then. */
  let failed = failedProvider;
  let lastErr = err;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    /*- Report, rather than command.  `false` means either that another
     *  caller already moved us off this endpoint — in which case the
     *  retry below simply uses theirs — or that every endpoint has been
     *  tried, which is a reason to come back round to the first one
     *  rather than to give up, since an outage covering all of them is
     *  precisely the case this loop exists for.
     *
     *  Only when there IS a failure to report.  A caller that arrives
     *  having already failed names the provider it saw fail and so
     *  reports on its first attempt; one that has attempted nothing yet
     *  must not, for two reasons.  It would step selection for a read
     *  that then succeeds, and it would step it unnamed — which skips
     *  the guard in `failoverToNextRPC` that keeps ten concurrent
     *  callers from each advancing the list once. */
    const moved = _report(failover, failed);
    if (attempt > 1 && !moved && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const next = current();
    try {
      const value = await run(next);
      note(next, true);
      /*- `attempt > 1` is the "a failure was logged" test, not a second
       *  flag tracking it: every catch below logs, so reaching attempt
       *  N means N-1 lines were printed.  Attempt 1 succeeding means
       *  this loop said nothing, and the pre-loop failure that sent us
       *  here is not ours to announce. */
      if (attempt > 1) {
        _logRecovery(tag, label, attempt - 1, urlOf(next), urlOf(failed));
      }
      return value;
    } catch (e) {
      if (!isFailoverable(e)) throw e;
      note(next, false);
      failed = next;
      lastErr = e;
      _logAttemptFailure(tag, label, attempt, maxAttempts, urlOf(next), e);
    }
  }
  return onExhausted(maxAttempts, lastErr);
}

module.exports = { retryRead };
