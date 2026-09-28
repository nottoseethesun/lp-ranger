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
 */

const { log } = require("./log");

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
      return await next[prop].apply(next, args);
    } catch (e) {
      if (!isFailoverable(e)) throw e;
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
