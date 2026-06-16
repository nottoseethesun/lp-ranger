/**
 * @file src/block-time-cache.js
 * @module blockTimeCache
 * @description
 * Disk-backed JSON cache mapping block numbers to UTC timestamps (Unix seconds).
 * Block timestamps are immutable, so entries never expire.
 *
 * Used by historical price fetchers that need a real block-time when querying
 * date-bucketed APIs like GeckoTerminal OHLCV (`before_timestamp`).
 *
 * Cache file: `tmp/block-time-cache.json` (gitignored).
 * Lazy-loaded on first access; batched writes via dirty flag.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");

// Cache path can be overridden via env var so tests cannot ever clobber the
// production file, regardless of how the test is invoked.
const _CACHE_PATH =
  process.env.BLOCK_TIME_CACHE_PATH ||
  path.join(process.cwd(), "tmp", "block-time-cache.json");

/** @type {Record<string, number> | null} */
let _cache = null;
let _dirty = false;

/** Lazy-load the cache from disk. */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    _cache = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch {
    _cache = {};
  }
}

/** Build a cache key from blockchain + block number. */
function _key(blockchain, blockNumber) {
  return `${blockchain}-${blockNumber}`;
}

/**
 * Resolve a block number to its Unix-seconds timestamp.
 * Hits cache first; falls back to `provider.getBlock(blockNumber)` and persists.
 *
 * @param {object} provider     ethers JsonRpcProvider (or compatible).
 * @param {string} blockchain   Chain name (e.g. 'pulsechain').
 * @param {number} blockNumber  Block number to resolve.
 * @returns {Promise<number>}   Unix seconds, or 0 on failure.
 */
async function getBlockTimestamp(provider, blockchain, blockNumber) {
  _ensureLoaded();
  const k = _key(blockchain, blockNumber);
  if (_cache[k]) return _cache[k];
  if (!provider) return 0;
  try {
    const block = await provider.getBlock(blockNumber);
    const ts = Number(block?.timestamp ?? 0);
    if (ts > 0) {
      _cache[k] = ts;
      _dirty = true;
    }
    return ts;
  } catch (err) {
    log.warn(
      "[block-time-cache] getBlock(%d) failed: %s",
      blockNumber,
      err.message ?? err,
    );
    return 0;
  }
}

/** Write the cache to disk if any new entries were added since last flush. */
function flushBlockTimeCache() {
  if (!_dirty || !_cache) return;
  try {
    fs.mkdirSync(path.dirname(_CACHE_PATH), { recursive: true });
    fs.writeFileSync(_CACHE_PATH, JSON.stringify(_cache, null, 2), "utf8");
    _dirty = false;
  } catch (err) {
    log.warn("[block-time-cache] Could not write cache:", err.message);
  }
}

/** Reset in-memory state (for testing). */
function _resetForTest() {
  _cache = null;
  _dirty = false;
}

module.exports = {
  getBlockTimestamp,
  flushBlockTimeCache,
  _resetForTest,
  _CACHE_PATH,
};
