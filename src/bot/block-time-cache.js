/**
 * @file src/bot/block-time-cache.js
 * @module blockTimeCache
 * @description
 * Disk-backed JSON cache mapping block numbers to UTC timestamps (Unix seconds).
 * Block timestamps are immutable, so entries never expire.
 *
 * Used by the Lifetime deposit pricing (`priceDepositEntries`,
 * src/bot/bot-hodl-scan.js), which needs a deposit's block time to ask a
 * date-bucketed price api, such as GeckoTerminal's OHLCV
 * (`before_timestamp`), for that day's price.
 *
 * Cache file: `app-data/scan-cache/block-time-cache.json` (gitignored;
 * src/lib/scan-cache-dir.js).
 * Lazy-loaded on first access; batched writes via dirty flag.
 */

"use strict";

const { log } = require("../lib/log");
const { tellFileProblem } = require("../lib/file-problem");
const fs = require("fs");
const { scanCachePath } = require("../lib/scan-cache-dir");
const { replaceJsonFile } = require("../lib/shared-json-file");
const { readEnv } = require("../lib/env-settings");

/*-
 *  `BLOCK_TIME_CACHE_PATH` moves the file, read through `readEnv`, so a
 *  blank value names none. Under `node --test` the cache folder is the
 *  test process's own anyway (`scanCachePath`).
 */
const _CACHE_PATH =
  readEnv("BLOCK_TIME_CACHE_PATH") ?? scanCachePath("block-time-cache.json");

/** @type {Record<string, number> | null} */
let _cache = null;
let _dirty = false;

/** Lazy-load the cache from disk. */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    _cache = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch (err) {
    tellFileProblem({ doing: "read", file: _CACHE_PATH, err });
    _cache = {};
  }
}

/** Build a cache key from blockchain + block number. */
function _key(blockchain, blockNumber) {
  return `${blockchain}-${blockNumber}`;
}

/**
 * Resolve a block number to its Unix-seconds timestamp.
 * Hits the cache first; else asks `provider.getBlock(blockNumber)` and
 * keeps a positive answer in memory, for `flushBlockTimeCache` to write.
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

/**
 * Write the cache to disk if any new entries were added since last flush,
 * replaced whole through a copy (src/lib/shared-json-file.js), so a write
 * cut short leaves the last copy whole.
 */
function flushBlockTimeCache() {
  if (!_dirty || !_cache) return;
  try {
    replaceJsonFile(_CACHE_PATH, _cache);
    _dirty = false;
  } catch (err) {
    tellFileProblem({ doing: "write to", file: _CACHE_PATH, err });
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
