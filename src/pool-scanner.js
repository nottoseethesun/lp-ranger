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
const { scanRebalanceHistory, buildCacheKey } = require('./event-scanner');
const { createCacheStore, eventCachePath } = require('./cache-store');

const _C = '\x1b[30;48;5;123m';
const _R = '\x1b[0m';
function _log(msg, ...a) {
  console.log(_C + '[pool-scan] ' + msg + _R, ...a);
}

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
    _log(' Waiting for lock on %s', tag);
  const release = await lock.acquire();
  _log(' Lock acquired for %s', tag);
  try {
    const cache = createCacheStore({
      filePath: eventCachePath(position, 'pulsechain', config.POSITION_MANAGER, walletAddress),
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
    _log('Scan complete for %s \u2014 %d events',
      tag, events.length);
    if (opts.afterScan) {
      _log('Running afterScan for %s', tag);
      await opts.afterScan(events);
    }
    return events;
  } finally {
    release();
    _log(' Lock released for %s', tag);
  }
}

/**
 * Clear the event cache for a pool.  Called after rebalance
 * so the next scan picks up the new NFT mint event.
 * @param {object} position  Must have token0, token1, fee.
 * @param {string} wallet    Wallet address.
 */
async function clearPoolCache(position, wallet) {
  const cache = createCacheStore({
    filePath: eventCachePath(position, 'pulsechain', config.POSITION_MANAGER, wallet),
  });
  await cache.clear();
  _log('Event cache cleared for %s\u2026/%s\u2026 fee=%s',
    position.token0.slice(0, 8),
    position.token1.slice(0, 8), position.fee);
}

/**
 * Append a rebalance event to the pool's event cache.
 * Avoids clearing the entire cache and forcing a full rescan.
 * @param {object} position  Must have token0, token1, fee.
 * @param {string} wallet    Wallet address.
 * @param {object} result    Rebalance result from executeRebalance.
 */
async function appendToPoolCache(position, wallet, result) {
  const cache = createCacheStore({
    filePath: eventCachePath(
      position, 'pulsechain',
      config.POSITION_MANAGER, wallet),
  });
  const cacheKey = buildCacheKey(
    wallet, config.POSITION_MANAGER,
    position.token0, position.token1, position.fee,
  );
  const existing = await cache.get(cacheKey);
  const events = existing?.events || [];
  const ts = Math.floor(Date.now() / 1000);
  const txHash = Array.isArray(result.txHashes)
    ? result.txHashes[result.txHashes.length - 1]
    : '';
  events.push({
    index: 0,
    timestamp: ts,
    dateStr: new Date(ts * 1000).toISOString(),
    oldTokenId: String(result.oldTokenId || '?'),
    newTokenId: String(result.newTokenId || '?'),
    txHash: txHash || '',
    blockNumber: result.blockNumber || 0,
  });
  events.sort((a, b) => a.timestamp - b.timestamp);
  events.forEach((e, i) => { e.index = i + 1; });
  const lastBlock = result.blockNumber
    || existing?.lastBlock || 0;
  await cache.set(cacheKey, {
    events,
    lastBlock,
    firstMintTimestamp: existing?.firstMintTimestamp
      || null,
  });
  _log('Appended rebalance event to cache for'
    + ' %s\u2026/%s\u2026 fee=%s (%d events)',
    position.token0.slice(0, 8),
    position.token1.slice(0, 8),
    position.fee, events.length);
}

module.exports = {
  scanPoolHistory, getPoolScanLock,
  clearPoolCache, appendToPoolCache,
};
