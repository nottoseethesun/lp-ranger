"use strict";

/**
 * @file src/rpc-read-retry.js
 * @module rpc-read-retry
 *
 * Retry loop for reads served by the managed read provider.
 *
 * Extracted from `src/send-transaction.js` rather than living beside the
 * failover state it drives, for two reasons: that file sits on the
 * 500-line cap, and the dependencies arrive by injection here, so the
 * loop can be exercised directly without booting the transaction layer
 * or standing up providers.
 *
 * **Why it never gives up.** The alternative is dropping the read. For a
 * chunked log scan a dropped read is a block window that is never read,
 * which leaves the pool's rebalance chain short a rebalance — and epoch
 * count, Lifetime and Cumulative P&L and IL/G are then all computed over
 * an incomplete history and rendered as settled fact. A stalled scan is
 * visible in the log and recoverable by waiting; a silently short one is
 * neither. These outages almost always heal.
 *
 * **Why there is no backoff.** Every provider is built by
 * `bot-provider.buildProvider`, which funnels each call through the
 * global pacing queue (`src/rpc-request-manager.js`), so attempts are
 * already spaced by `globalRPCRequestRateIntervalMS` and this loop
 * cannot spin. A delay here would be a second rate mechanism competing
 * with the one that owns the schedule — the very "hole through which the
 * rate escapes" that module warns against.
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
 * line worth printing: the two being different says selection moved and
 * another endpoint served the read, while the two being equal says the
 * original endpoint recovered on its own and nothing moved. Those are
 * the two outcomes a reader cannot otherwise tell apart, and they call
 * for different follow-up.
 *
 * Both urls are optional because `urlOf` is injected and a caller
 * without an endpoint list resolves neither; the line then carries the
 * count alone, which still answers whether the read completed.
 *
 * @param {string|symbol} prop   Provider method that was retried.
 * @param {number} failures      Attempts that failed before this one.
 * @param {?string} servedBy     Endpoint that answered, if known.
 * @param {?string} lastFailed   Endpoint that failed last, if known.
 */
function _logRecovery(prop, failures, servedBy, lastFailed) {
  let where = "";
  if (servedBy && lastFailed && servedBy !== lastFailed) {
    where = ` — served by ${servedBy} (failed over from ${lastFailed})`;
  } else if (servedBy) {
    where = ` — ${servedBy} recovered, no failover`;
  }
  log.info(
    "[send-tx] read ok on %s after %d failed attempt(s)%s",
    String(prop),
    failures,
    where,
  );
}

/**
 * Retry a failed provider read across endpoints until one serves it.
 *
 * @param {object} opts
 * @param {string|symbol} opts.prop   Provider method being retried.
 * @param {unknown[]} opts.args       Original call arguments.
 * @param {Error} opts.err            The failure that triggered the retry.
 * @param {(e: unknown) => boolean} opts.isFailoverable  True when the
 *   error shape indicates the endpoint is at fault, not the request.
 * @param {(failed?: object) => boolean} opts.failover  Report that an
 *   endpoint failed; advances selection only if it is still on that one.
 * @param {() => object} opts.current    The endpoint to use now.
 * @param {(provider: object, ok: boolean) => void} opts.note  Record one
 *   attempt's outcome against the endpoint that served it. During an
 *   outage these attempts are most of the traffic, so a rate judged
 *   without them would be judged on a single sample.
 * @param {(provider: object) => ?string} [opts.urlOf]  Resolve a
 *   provider to its endpoint url, for the recovery line. Defaulted so a
 *   caller with no endpoint list still drives the loop.
 * @param {object} [opts.failedProvider] The provider whose failure is
 *   `err`. Naming it keeps concurrent failures on one endpoint from
 *   advancing the list once each.
 * @returns {Promise<*>}  The first successful result.
 * @throws  `err` when it is not failover-eligible, or any
 *   non-failoverable error raised by a later attempt.
 */
async function retryRead({
  prop,
  args,
  err,
  isFailoverable,
  failover,
  current,
  /*- Defaulted so a caller that has no decider to report to — a test
   *  driving the loop in isolation — does not crash on a missing
   *  function.  Production has one caller and it passes one. */
  note = () => {},
  urlOf = () => null,
  failedProvider,
}) {
  if (!isFailoverable(err)) throw err;
  /*- Which endpoint the failure being reported came from.  It changes
   *  every iteration, because each attempt runs against whichever
   *  endpoint selection had moved to by then. */
  let failed = failedProvider;
  for (let attempt = 1; ; attempt++) {
    /*- Report, rather than command.  `false` means either that another
     *  caller already moved us off this endpoint — in which case the
     *  retry below simply uses theirs — or that every endpoint has been
     *  tried, which is a reason to come back round to the first one
     *  rather than to give up, since an outage covering all of them is
     *  precisely the case this loop exists for. */
    failover(failed);
    const next = current();
    try {
      const value = await next[prop].apply(next, args);
      note(next, true);
      /*- `attempt > 1` is the "a failure was logged" test, not a second
       *  flag tracking it: every catch below logs, so reaching attempt
       *  N means N-1 lines were printed.  Attempt 1 succeeding means
       *  this loop said nothing, and the pre-loop failure that sent us
       *  here is not ours to announce. */
      if (attempt > 1) {
        _logRecovery(prop, attempt - 1, urlOf(next), urlOf(failed));
      }
      return value;
    } catch (e) {
      if (!isFailoverable(e)) throw e;
      note(next, false);
      failed = next;
      log.warn(
        "[send-tx] read retry #%d on %s failed: %s",
        attempt,
        String(prop),
        e.message,
      );
    }
  }
}

module.exports = { retryRead };
