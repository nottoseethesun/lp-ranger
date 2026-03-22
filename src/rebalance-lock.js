/**
 * @file src/rebalance-lock.js
 * @module rebalance-lock
 * @description
 * Async mutex for nonce-safe sequential rebalancing across multiple positions
 * sharing the same wallet.  Only one position can execute transactions at a
 * time (same wallet = same nonce).  Other positions continue polling and
 * computing P&L while queued for the lock.
 *
 * No timeout-based release — blockchains can hold a TX pending for days.
 * A timeout would free the lock while the nonce is still occupied, causing
 * every subsequent TX to fail with "could not replace existing tx."  The
 * lock holder is responsible for speed-up or 0-value self-cancel before
 * releasing.
 *
 * Uses the `async-mutex` package (Mutex) for the underlying lock.
 *
 * @example
 * const lock = createRebalanceLock();
 * const release = await lock.acquire();
 * try { await sendTx(); } finally { release(); }
 */

'use strict';

const { Mutex } = require('async-mutex');

/**
 * Create a rebalance lock (async mutex).
 *
 * @returns {{ acquire: () => Promise<() => void>, pending: () => number }}
 */
function createRebalanceLock() {
  const _mutex = new Mutex();
  let _acquireCount = 0;  // total calls to acquire (including holder)
  let _releaseCount = 0;  // total releases completed

  /**
   * Acquire the lock.  Resolves with a release function once it's this
   * caller's turn.  Callers queue in FIFO order.
   * @returns {Promise<() => void>}  Call the returned function to release.
   */
  function acquire() {
    _acquireCount++;
    return _mutex.acquire().then((release) => () => {
      _releaseCount++;
      release();
    });
  }

  /**
   * Number of callers currently waiting to acquire the lock (not including
   * the current holder).  Computed as: total_acquires - total_releases - 1 (holder).
   * @returns {number}
   */
  function pending() {
    const active = _acquireCount - _releaseCount;
    return Math.max(0, active - (_mutex.isLocked() ? 1 : 0));
  }

  return { acquire, pending };
}

module.exports = { createRebalanceLock };
