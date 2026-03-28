/**
 * @file cache-store.js
 * @module cache-store
 * @description
 * Simple JSON file-based cache for expensive-to-fetch data.  Each cache entry
 * has a key, a value (any JSON-serialisable object), and a TTL.  The cache is
 * loaded lazily on first access and persisted to disk on every write.
 *
 * Used by the event scanner (rebalance history) and P&L tracker (daily P&L
 * snapshots) to avoid re-fetching thousands of on-chain records every load.
 *
 * The app remains stateless from a correctness standpoint — the cache is a
 * pure performance optimisation.  If the cache file is deleted, everything is
 * rebuilt from the blockchain.
 *
 * @example
 * const cache = createCacheStore({ filePath: './cache/events.json', defaultTtlMs: 3600000 });
 * await cache.set('rebalance:0xABC', events, 86400000);
 * const hit = await cache.get('rebalance:0xABC');
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} CacheEntry
 * @property {*}      value     - Cached value (must be JSON-serialisable).
 * @property {number} expiresAt - Unix ms when this entry expires.
 */

/**
 * @typedef {Object} CacheStore
 * @property {function(string): Promise<*|null>}          get    - Retrieve a cached value by key.
 * @property {function(string, *, number=): Promise<void>} set    - Store a value with optional TTL override.
 * @property {function(string): Promise<boolean>}         delete - Remove a single entry.
 * @property {function(): Promise<void>}                  clear  - Remove all entries.
 * @property {function(): number}                         size   - Number of entries (including expired).
 */

/**
 * Create a file-backed cache store.
 *
 * @param {Object} opts
 * @param {string} opts.filePath      - Path to the JSON cache file.
 * @param {number} [opts.defaultTtlMs=86400000] - Default TTL in ms (24 hours).
 * @param {Object} [opts.fsModule]    - Injected fs module (for testing).
 * @returns {CacheStore}
 */
function createCacheStore(opts) {
  const { filePath, defaultTtlMs = 86_400_000, fsModule = fs } = opts;

  /** @type {Map<string, CacheEntry>|null} */
  let store = null;

  /**
   * Load the cache from disk into memory. Creates the directory if needed.
   * Silently starts with an empty Map on any error.
   */
  function _load() {
    if (store !== null) return;
    try {
      const raw = fsModule.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      store = new Map(Object.entries(parsed));
    } catch (_) {
      store = new Map();
    }
  }

  /**
   * Persist the in-memory Map to disk as JSON.
   * Creates parent directories as needed.
   */
  function _save() {
    const obj = Object.fromEntries(store);
    const dir = path.dirname(filePath);
    try {
      fsModule.mkdirSync(dir, { recursive: true });
      fsModule.writeFileSync(
        filePath,
        JSON.stringify(obj, null, 2),
        'utf8',
      );
    } catch (err) {
      console.warn('[cache-store] Failed to persist cache:', err.message);
    }
  }

  /**
   * Retrieve a cached value. Returns null if missing or expired.
   * @param {string} key
   * @returns {Promise<*|null>}
   */
  async function get(key) {
    _load();
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      _save();
      return null;
    }
    return entry.value;
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {*}      value   - Must be JSON-serialisable.
   * @param {number} [ttlMs] - TTL in ms. Defaults to opts.defaultTtlMs.
   * @returns {Promise<void>}
   */
  async function set(key, value, ttlMs) {
    _load();
    const ttl = ttlMs ?? defaultTtlMs;
    store.set(key, { value, expiresAt: Date.now() + ttl });
    _save();
  }

  /**
   * Delete a single cache entry.
   * @param {string} key
   * @returns {Promise<boolean>} True if the entry existed.
   */
  async function del(key) {
    _load();
    const had = store.delete(key);
    if (had) _save();
    return had;
  }

  /**
   * Remove all entries.
   * @returns {Promise<void>}
   */
  async function clear() {
    _load();
    store.clear();
    _save();
  }

  /**
   * Return the number of entries (including expired ones not yet pruned).
   * @returns {number}
   */
  function size() {
    _load();
    return store.size;
  }

  return { get, set, delete: del, clear, size };
}

/**
 * Build a deterministic cache file path for event scanning, keyed by pool
 * (token0 + token1 + fee) instead of tokenId. This lets cache survive across
 * rebalances that mint new NFTs in the same pool.
 *
 * @param {{ token0: string, token1: string, fee: number|string }} position
 * @returns {string} Absolute path under tmp/
 */
function eventCachePath(position) {
  const t0 = position.token0.slice(2, 10).toLowerCase();
  const t1 = position.token1.slice(2, 10).toLowerCase();
  return path.join(
    process.cwd(),
    'tmp',
    `event-cache-pool-${t0}-${t1}-${position.fee}.json`,
  );
}

module.exports = { createCacheStore, eventCachePath };
