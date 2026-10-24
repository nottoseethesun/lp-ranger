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

"use strict";

const { log } = require("./log");
const { Mutex } = require("async-mutex");
const config = require("./config");
const { scanRebalanceHistory, buildCacheKey } = require("./event-scanner");
const { createCacheStore, eventCachePath } = require("./cache-store");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { poolKey } = require("./pool-key");
const {
  activityFieldsOf,
  withFinishedFigures,
} = require("./rebalance-activity-figures");

const _C = "\x1b[30;48;5;123m";
const _R = "\x1b[0m";
function _log(msg, ...a) {
  log.info(_C + "[pool-scan] " + msg + _R, ...a);
}

/*-
 *  How long the event cache keeps a pool's history after its last
 *  write, and how long a finished scan is handed to the next caller
 *  asking for the same pool: `eventCacheTtlMs` and `poolScanReuseMs` in
 *  bot-config-defaults.json, whose comment explains both.
 */
const _EVENT_CACHE_TTL_MS = readBotConfigDefaults().eventCacheTtlMs;
const _RECENT_TTL_MS = readBotConfigDefaults().poolScanReuseMs;

/** Per-pool scan locks — different pools scan in parallel. */
const _locks = new Map();

/*- Per-pool AbortControllers for in-flight scans. Keyed identically to
 *  `_locks` so cancelPoolScan() can find the controller by the same
 *  token0/token1/fee tuple the caller used. Entries are removed in the
 *  scanPoolHistory() finally-block. */
const _activeScans = new Map();

/** Build the canonical pool key used by both the lock and active-scan maps. */
function _poolKey(token0, token1, fee) {
  return (token0 + "-" + token1 + "-" + fee).toLowerCase();
}

/** The pool's event cache file for one wallet, on the active chain. */
function _eventCacheFor(position, wallet) {
  return createCacheStore({
    filePath: eventCachePath(
      position,
      config.CHAIN_NAME,
      config.POSITION_MANAGER,
      wallet,
    ),
    defaultTtlMs: _EVENT_CACHE_TTL_MS,
  });
}

/** The key of the one entry that file holds, as the scanner writes it. */
function _eventCacheKey(position, wallet) {
  return buildCacheKey(
    wallet,
    config.POSITION_MANAGER,
    position.token0,
    position.token1,
    position.fee,
  );
}

/**
 * Get or create a per-pool mutex.
 * @param {string} token0
 * @param {string} token1
 * @param {number|string} fee
 * @returns {Mutex}
 */
function getPoolScanLock(token0, token1, fee) {
  const k = _poolKey(token0, token1, fee);
  if (!_locks.has(k)) _locks.set(k, new Mutex());
  return _locks.get(k);
}

/**
 * Abort any in-flight scan for a pool and invalidate the recent-scan TTL
 * entry.  No-op when no scan is active.
 *
 * The abort signal flows into the event-scanner's chunk loop, which checks
 * it between chunks.  On next check the scanner throws AbortError, the
 * finally-block in scanPoolHistory() releases the mutex, and a subsequent
 * caller can start fresh.  Raw chain events already written to the disk
 * cache remain valid — only the in-memory recent-scan entry is dropped so
 * the restart does not return a stale cached result.
 *
 * @param {string} token0
 * @param {string} token1
 * @param {number|string} fee
 * @param {string} [walletAddress]  When provided, also invalidates that
 *   wallet's recent-scan entry for the pool.
 * @returns {boolean}  True if a scan was aborted; false if none was active.
 */
function cancelPoolScan(token0, token1, fee, walletAddress) {
  const k = _poolKey(token0, token1, fee);
  const ctrl = _activeScans.get(k);
  const aborted = !!ctrl;
  if (ctrl) {
    _log(" Aborting in-flight scan for %s", k);
    ctrl.abort();
    _activeScans.delete(k);
  }
  /*-
   *  Drop the recent-scan entry for this pool+wallet so the next call
   *  does not short-circuit to the stale cached result.
   */
  _recentScans.delete(_recentKey({ token0, token1, fee }, walletAddress));
  return aborted;
}

/**
 * The key of a pool's recent-scan entry: the canonical pool key from
 * `src/pool-key.js` \u2014 chain, position manager, wallet, pair and fee tier,
 * whole addresses in either case. One builder for every place that reads,
 * writes or drops an entry, so all of them name the same one.
 *
 * @param {{token0: string, token1: string, fee: number|string}} position
 * @param {string} walletAddress
 * @returns {string}
 */
function _recentKey(position, walletAddress) {
  return poolKey(
    config.CHAIN_NAME,
    config.POSITION_MANAGER,
    walletAddress,
    position.token0,
    position.token1,
    position.fee,
  );
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
 * @param {function} [opts.computeFromHistoricalPrices]   Called with (events) while the lock is
 *   still held — use for epoch reconstruction so the second caller finds
 *   cached results instead of reconstructing in parallel.
 * @returns {Promise<object[]>}  Array of RebalanceEvent objects.
 */
const _recentScans = new Map();

async function scanPoolHistory(provider, ethersLib, opts) {
  const { walletAddress, position } = opts;
  const lock = getPoolScanLock(position.token0, position.token1, position.fee);
  const t0s = position.token0.slice(0, 8);
  const t1s = position.token1.slice(0, 8);
  const tag = `${t0s}\u2026/${t1s}\u2026 fee=${position.fee}`;
  const recentKey = _recentKey(position, walletAddress);
  // Check recent scan BEFORE acquiring lock — return cached events immediately
  // if no callback needs to run. If a callback is needed, fall through to the
  // lock path so the callback runs under lock protection (prevents duplicate
  // epoch reconstruction from concurrent detail fetches).
  const recent = _recentScans.get(recentKey);
  if (recent && Date.now() - recent.at < _RECENT_TTL_MS) {
    if (!opts.computeFromHistoricalPrices) return recent.events;
  }
  const pending = lock.isLocked();
  if (pending) _log(" Waiting for lock on %s", tag);
  const _lockWaitStart = Date.now();
  const release = await lock.acquire();
  const _lockWaitMs = Date.now() - _lockWaitStart;
  const recent2 = _recentScans.get(recentKey);
  if (recent2 && Date.now() - recent2.at < _RECENT_TTL_MS) {
    _log(" Using recent scan result for %s (waited %dms)", tag, _lockWaitMs);
    try {
      if (opts.computeFromHistoricalPrices)
        await opts.computeFromHistoricalPrices(recent2.events);
    } finally {
      release();
    }
    return recent2.events;
  }
  _log(" Lock acquired for %s (waited %dms)", tag, _lockWaitMs);
  /*- Register an AbortController for this pool so cancelPoolScan() can
   *  signal the event-scanner's chunk loop to bail out cooperatively. */
  const poolK = _poolKey(position.token0, position.token1, position.fee);
  const controller = new AbortController();
  _activeScans.set(poolK, controller);
  let events;
  try {
    const cache = _eventCacheFor(position, walletAddress);
    events = await scanRebalanceHistory(provider, ethersLib, {
      positionManagerAddress: config.POSITION_MANAGER,
      walletAddress,
      cache,
      factoryAddress: config.FACTORY,
      poolAddress: opts.poolAddress || null,
      poolToken0: position.token0,
      poolToken1: position.token1,
      poolFee: position.fee,
      onPoolCreationProgress: opts.onPoolCreationProgress,
      onProgress: opts.onProgress,
      signal: controller.signal,
    });
    _log(
      "Scan complete for %s \u2014 %d events (scan took %dms)",
      tag,
      events.length,
      Date.now() - _lockWaitStart - _lockWaitMs,
    );
  } finally {
    /*- Only remove our controller if it's still the registered one; a
     *  concurrent cancelPoolScan already deletes it on abort. */
    if (_activeScans.get(poolK) === controller) _activeScans.delete(poolK);
    release();
    _log(
      " Lock released for %s (held %dms)",
      tag,
      Date.now() - _lockWaitStart - _lockWaitMs,
    );
  }
  _recentScans.set(recentKey, { events, at: Date.now() });
  if (opts.computeFromHistoricalPrices) {
    const _priceT0 = Date.now();
    _log(
      "Computing P&L — fetching price data from" +
        " cache or remote API for %s\u2026" +
        " (run with --verbose for detail)",
      tag,
    );
    await opts.computeFromHistoricalPrices(events);
    _log("P&L computation done for %s (%dms)", tag, Date.now() - _priceT0);
  }
  return events;
}

/**
 * Clear the event cache for a pool, so the next scan reads its whole
 * history from the chain again.  Called only by Reload Current Position
 * (`src/server-reload-position.js`); a rebalance appends its event with
 * `appendToPoolCache` instead.
 * @param {object} position  Must have token0, token1, fee.
 * @param {string} wallet    Wallet address.
 */
async function clearPoolCache(position, wallet) {
  const cache = _eventCacheFor(position, wallet);
  await cache.clear();
  _log(
    "Event cache cleared for %s\u2026/%s\u2026 fee=%s",
    position.token0.slice(0, 8),
    position.token1.slice(0, 8),
    position.fee,
  );
}

/** Build the cache event entry for a freshly-completed rebalance. */
function _buildEventEntry(result) {
  const ts = Math.floor(Date.now() / 1000);
  const txHash = Array.isArray(result.txHashes)
    ? result.txHashes[result.txHashes.length - 1]
    : "";
  return {
    index: 0,
    timestamp: ts,
    dateStr: new Date(ts * 1000).toISOString(),
    oldTokenId: String(result.oldTokenId || "?"),
    newTokenId: String(result.newTokenId || "?"),
    txHash: txHash || "",
    blockNumber: result.blockNumber,
    swapSources: result.swapSources || "(no swap)",
    // What started it, which its Activity Log entry names.
    trigger: result.trigger,
    ...activityFieldsOf(result),
  };
}

/**
 * Append a rebalance event to the pool's event cache, so the next scan
 * starts after the rebalance instead of clearing the cache and reading
 * the pool's whole history again.
 *
 * Runs under the same per-pool lock as `scanPoolHistory`, because both
 * read the file, change it and write it back, and an interleaving would
 * lose the append. An event the cache already holds, matched by its
 * transaction, is not added twice.
 *
 * @param {object} position  Must have token0, token1, fee.
 * @param {string} wallet    Wallet address.
 * @param {object} result    Rebalance result from executeRebalance.
 */
async function appendToPoolCache(position, wallet, result) {
  /*-
   *  Built before the wait below, so its timestamp is when the rebalance
   *  finished rather than when a scan holding the lock let go of it.
   */
  const entry = _buildEventEntry(result);
  /*-
   *  Under the pool's scan lock. A scan reads this file when it starts
   *  and writes back what it read plus what it found, so an entry
   *  appended while one runs is overwritten when it finishes. Held here,
   *  the append lands either before a scan reads the file or after one
   *  has written it.
   */
  const release = await getPoolScanLock(
    position.token0,
    position.token1,
    position.fee,
  ).acquire();
  try {
    const cache = _eventCacheFor(position, wallet);
    const cacheKey = _eventCacheKey(position, wallet);
    const existing = await cache.get(cacheKey);
    const events = existing?.events || [];
    /*-
     *  A scan that held the lock first may already have read this
     *  rebalance from the chain. The scanner's own merge keeps one entry
     *  per transaction, and so does this.
     */
    const known =
      entry.txHash !== "" && events.some((e) => e.txHash === entry.txHash);
    if (!known) events.push(entry);
    log.info(
      "[route-trace] pool-scanner persisted newTokenId=%s swapSources=%s",
      String(result.newTokenId || "?"),
      result.swapSources || "(null)",
    );
    events.sort((a, b) => a.timestamp - b.timestamp);
    events.forEach((e, i) => {
      e.index = i + 1;
    });
    /*-
     *  Written back whole, with only the events changed, so nothing a
     *  scan stored beside them is lost: the chain's first mint among
     *  them. `lastBlock` is how far a scan has read the chain, and an
     *  append reads none of it, so it stays where the last scan left it.
     *  The blocks between there and this rebalance's mint have not been
     *  read, and the next scan starts at them. The schema marker is set
     *  for an entry this creates, so `event-scanner.loadCache` does not
     *  drop it as an old one.
     */
    await cache.set(cacheKey, {
      ...existing,
      events,
      mintSchemaVersion: 2,
    });
    _log(
      "Appended rebalance event to cache for" +
        " %s\u2026/%s\u2026 fee=%s (%d events)",
      position.token0.slice(0, 8),
      position.token1.slice(0, 8),
      position.fee,
      events.length,
    );
    /*-
     *  Invalidate the in-memory `_recentScans` entry for this pool+wallet
     *  so a queued `scanPoolHistory()` call does not short-circuit to the
     *  events its reuse check would return. A scan that held the lock
     *  before this append publishes its result as it releases the lock,
     *  and that result was read before the rebalance. A scan queued
     *  behind this append would otherwise find it still fresh and return
     *  the events from BEFORE the rebalance, missing the new
     *  oldTokenId/newTokenId pair. The dashboard's Rebalance Events table
     *  and `_resolveManagedTid` auto-follow would then miss the rebalance
     *  until the reuse window expires. Done before the lock is released,
     *  so no queued scan can see the entry. Mirrors the same delete in
     *  cancelPoolScan.
     */
    _recentScans.delete(_recentKey(position, wallet));
  } finally {
    release();
  }
}

/**
 * Write finished Activity Log figures into the pool's event cache.
 *
 * A rebalance's figures are finished after the scan that follows it
 * (src/bot-rebalance-figures.js), when the cache already holds its event.
 * This puts each finished event's figures into the cached record with the
 * same transaction, through `withFinishedFigures`, so the figures survive
 * a restart and a later scan's merge keeps them; the cache holds the
 * Activity Log entry's own record of each rebalance. Runs under the pool's
 * scan lock for the same reason `appendToPoolCache` does, and forgets the
 * pool's recent scan so the next caller reads the finished records.
 *
 * @param {object} position  Must have token0, token1, fee.
 * @param {string} wallet    Wallet address.
 * @param {Map<string, object>} finished  Finished event records, by
 *   transaction hash.
 */
async function updateCachedEvents(position, wallet, finished) {
  if (!(finished instanceof Map) || finished.size === 0) return;
  const release = await getPoolScanLock(
    position.token0,
    position.token1,
    position.fee,
  ).acquire();
  try {
    const cache = _eventCacheFor(position, wallet);
    const cacheKey = _eventCacheKey(position, wallet);
    const existing = await cache.get(cacheKey);
    if (!Array.isArray(existing?.events)) return;
    const events = existing.events.map((e) => {
      const done = finished.get(e.txHash);
      return done === undefined ? e : withFinishedFigures(e, done);
    });
    await cache.set(cacheKey, { ...existing, events });
    _recentScans.delete(_recentKey(position, wallet));
  } finally {
    release();
  }
}

module.exports = {
  scanPoolHistory,
  getPoolScanLock,
  cancelPoolScan,
  clearPoolCache,
  appendToPoolCache,
  updateCachedEvents,
  /*- Test-only window onto the module-private `_recentScans` Map so the
   *  regression test for appendToPoolCache's cache-invalidation
   *  behaviour can seed and inspect entries without going through a
   *  full mocked scanPoolHistory run.  Mirrors the test-only-export
   *  pattern used by `_withTimestamp` / `_setSinkForTests` in
   *  `src/log.js`. */
  _recentScansForTests: _recentScans,
  _recentKey, // exported for tests, so they key entries as the scanner does
};
