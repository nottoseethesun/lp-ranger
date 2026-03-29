/**
 * @file pool-scanner.js
 * @module poolScanner
 * @description
 * Single consolidated entry point for scanning a pool's rebalance history.
 * Provides per-pool locking so only one scan runs per pool at a time,
 * and creates/reuses the pool-keyed event cache.
 *
 * Both bot-recorder.js (managed positions) and position-details.js
 * (unmanaged position viewer) call through here instead of invoking
 * scanRebalanceHistory directly.
 */

'use strict';

const { Mutex } = require('async-mutex');
const config = require('./config');
const { scanRebalanceHistory } = require('./event-scanner');
const { createCacheStore, eventCachePath } = require('./cache-store');

const _TAG = '\x1b[30;48;5;123m[pool-scan]\x1b[0m';

/** Per-pool scan locks — different pools scan in parallel. */
const _locks = new Map();

/**
 * Get or create a per-pool mutex.
 * @param {string} token0
 * @param {string} token1
 * @param {number|string} fee
 * @returns {Mutex}
 */
function getPoolScanLock(token0, token1, fee) {
  const k = (token0 + '-' + token1 + '-' + fee).toLowerCase();
  if (!_locks.has(k)) _locks.set(k, new Mutex());
  return _locks.get(k);
}

/**
 * Scan a pool's rebalance history with per-pool locking and caching.
 *
 * Acquires a per-pool mutex so concurrent requests for the same pool
 * serialize (second caller finds cache warm).  Different pools scan
 * in parallel.
 *
 * @param {object} provider  ethers provider.
 * @param {object} ethersLib  ethers library.
 * @param {object} opts
 * @param {string} opts.walletAddress
 * @param {object} opts.position  Must have token0, token1, fee.
 * @param {string} [opts.poolAddress]  Resolved pool address (optional, for pool-age optimisation).
 * @param {function} [opts.onPoolCreationProgress]  (done, total) callback.
 * @param {function} [opts.onProgress]  (done, total) callback for chunk progress.
 * @param {function} [opts.afterScan]   Called with (events) while the lock is
 *   still held — use for epoch reconstruction so the second caller finds
 *   cached results instead of reconstructing in parallel.
 * @returns {Promise<object[]>}  Array of RebalanceEvent objects.
 */
async function scanPoolHistory(provider, ethersLib, opts) {
  const { walletAddress, position } = opts;
  const lock = getPoolScanLock(
    position.token0, position.token1, position.fee,
  );
  const t0s = position.token0.slice(0, 8);
  const t1s = position.token1.slice(0, 8);
  const tag = `${t0s}\u2026/${t1s}\u2026 fee=${position.fee}`;
  const pending = lock.isLocked();
  if (pending)
    console.log(_TAG + ' Waiting for lock on %s', tag);
  const release = await lock.acquire();
  console.log(_TAG + ' Lock acquired for %s', tag);
  try {
    const cache = createCacheStore({
      filePath: eventCachePath(position),
    });
    const events = await scanRebalanceHistory(
      provider, ethersLib, {
        positionManagerAddress: config.POSITION_MANAGER,
        walletAddress,
        maxYears: 5,
        cache,
        factoryAddress: config.FACTORY,
        poolAddress: opts.poolAddress || null,
        poolToken0: position.token0,
        poolToken1: position.token1,
        poolFee: position.fee,
        onPoolCreationProgress:
          opts.onPoolCreationProgress,
        onProgress: opts.onProgress,
      },
    );
    console.log(
      _TAG + ' Scan complete for %s \u2014 %d events',
      tag, events.length,
    );
    if (opts.afterScan) {
      console.log(_TAG + ' Running afterScan for %s', tag);
      await opts.afterScan(events);
    }
    return events;
  } finally {
    release();
    console.log(_TAG + ' Lock released for %s', tag);
  }
}

/**
 * Clear the event cache for a pool.  Called after rebalance
 * so the next scan picks up the new NFT mint event.
 * @param {object} position  Must have token0, token1, fee.
 */
async function clearPoolCache(position) {
  const cache = createCacheStore({
    filePath: eventCachePath(position),
  });
  await cache.clear();
  console.log(
    _TAG + ' Event cache cleared for %s\u2026/%s\u2026 fee=%s',
    position.token0.slice(0, 8),
    position.token1.slice(0, 8),
    position.fee,
  );
}

module.exports = {
  scanPoolHistory, getPoolScanLock, clearPoolCache,
};
