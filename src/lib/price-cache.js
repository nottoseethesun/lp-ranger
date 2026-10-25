/**
 * @file src/lib/price-cache.js
 * @module priceCache
 * @description
 * Disk-backed JSON cache for immutable historical token prices.
 * Keyed by `blockchain-tokenAddress-YYYY-MM-DDTHH:MM` (UTC, minute granularity).
 * Token prices are pool-independent — cached by token contract address, not pool.
 *
 * Cache file: `app-data/scan-cache/historical-price-cache.json`
 * (gitignored; src/lib/scan-cache-dir.js).
 * Deleted by `npm run clean`; preserved by `npm run dev-clean`.
 *
 * No TTL — historical prices never change.  Lazy-loaded on first access.
 * Batched writes via dirty flag: `set` marks dirty, `flush` writes only if
 * needed. A write reads the file as it is at that moment, lays this
 * process's prices over it, and replaces the file whole through a folder
 * of its own (src/lib/shared-json-file.js). So two processes can keep this
 * file at once, as LP Ranger and a tool under util/ that prices through
 * this library can. A write keeps every price the file held when it read
 * it, and a write that a process stopped part way leaves the file as it
 * was.
 * A price the other process writes after that read and before this
 * write's rename is dropped from the file. It stays in that process's
 * memory, and its next write puts it back, so only a run's last new
 * prices can be lost; a later run fetches them again.
 */

"use strict";

const { log } = require("./log");
const { scanCachePath } = require("./scan-cache-dir");
const { readJsonObject, replaceJsonFile } = require("./shared-json-file");

// Cache path can be overridden via env var so tests cannot ever clobber the
// production file, regardless of how the test is invoked.
const _CACHE_PATH =
  process.env.PRICE_CACHE_PATH || scanCachePath("historical-price-cache.json");

/** @type {Record<string, { priceUsd: number, cachedAt: string }> | null} */
let _cache = null;
let _dirty = false;

/** Read the full cache from disk (lazy, once). */
function _ensureLoaded() {
  if (_cache !== null) return;
  _cache = readJsonObject(_CACHE_PATH);
  const migrated = _migrateBlockKeys(_cache);
  if (migrated > 0) {
    log.info("[price-cache] Migrated %d block-scoped keys", migrated);
    _dirty = true;
  }
}

/**
 * One-time migration: strip date prefix from block-scoped keys.
 * Old format: `chain-token-YYYY-MM-DDTHH:MM@blockNumber`
 * New format: `chain-token-@blockNumber`
 * On collision (same block cached on multiple dates), keep the earliest
 * `cachedAt` entry — it is most likely the original historical fetch
 * rather than a same-day current-price fallback.
 *
 * Applied to the file read at load, and to the file read again at each
 * write, so a write does not bring back a key the load moved.
 * @param {Record<string, object>} entries  Changed in place.
 * @returns {number}  How many old keys it moved.
 */
function _migrateBlockKeys(entries) {
  const re = /^(.+)-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(@\d+)$/;
  let migrated = 0;
  for (const oldKey of Object.keys(entries)) {
    const m = oldKey.match(re);
    if (!m) continue;
    const newKey = `${m[1]}-${m[2]}`;
    const oldEntry = entries[oldKey];
    const existing = entries[newKey];
    if (!existing || (oldEntry.cachedAt || "") < (existing.cachedAt || "")) {
      entries[newKey] = oldEntry;
    }
    delete entries[oldKey];
    migrated++;
  }
  return migrated;
}

/**
 * Build a cache key from components.
 * @param {string} blockchain   Chain name (e.g. 'pulsechain').
 * @param {string} tokenAddress Token contract address.
 * @param {string} utcDateTime  UTC datetime: 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD'.
 * @returns {string} Dash-separated cache key.
 */
function _key(blockchain, tokenAddress, utcDateTime) {
  return `${blockchain}-${tokenAddress.toLowerCase()}-${utcDateTime}`;
}

/**
 * Convert a Unix-seconds timestamp to a UTC date string (YYYY-MM-DDT00:00).
 * Daily OHLCV close prices use T00:00 (UTC midnight).
 * @param {number} unixSeconds Unix timestamp in seconds.
 * @returns {string} UTC datetime string.
 */
function toUtcDayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10) + "T00:00";
}

/**
 * Look up a cached historical price.
 * @param {string} blockchain   Chain name.
 * @param {string} tokenAddress Token contract address.
 * @param {string} utcDateTime  UTC datetime ('YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD').
 * @returns {number|null} Cached USD price, or null if not found.
 */
function getHistoricalPrice(blockchain, tokenAddress, utcDateTime) {
  _ensureLoaded();
  // Try exact key first
  const k = _key(blockchain, tokenAddress, utcDateTime);
  const entry = _cache[k];
  if (entry) return entry.priceUsd;
  // If date-only (no 'T'), try daily close at T00:00
  if (!utcDateTime.includes("T")) {
    const dayK = _key(blockchain, tokenAddress, utcDateTime + "T00:00");
    const dayEntry = _cache[dayK];
    if (dayEntry) return dayEntry.priceUsd;
  }
  return null;
}

/**
 * Store a historical price in the cache (in-memory; call flush to persist).
 * @param {string} blockchain   Chain name.
 * @param {string} tokenAddress Token contract address.
 * @param {string} utcDateTime  UTC datetime ('YYYY-MM-DDTHH:MM').
 * @param {number} priceUsd     USD price.
 */
function setHistoricalPrice(blockchain, tokenAddress, utcDateTime, priceUsd) {
  _ensureLoaded();
  const k = _key(blockchain, tokenAddress, utcDateTime);
  _cache[k] = { priceUsd, cachedAt: new Date().toISOString() };
  _dirty = true;
}

/**
 * Write the cache to disk if any new prices were added since last flush:
 * the file as it is now, with this process's prices over it. Memory then
 * holds what the file does, so prices another process kept are not
 * fetched again. A write that fails stays dirty, for the next.
 */
function flushPriceCache() {
  if (!_dirty || _cache === null) return;
  try {
    const onDisk = readJsonObject(_CACHE_PATH);
    _migrateBlockKeys(onDisk);
    const merged = Object.assign(onDisk, _cache);
    replaceJsonFile(_CACHE_PATH, merged);
    _cache = merged;
    _dirty = false;
  } catch (err) {
    log.warn("[price-cache] Could not write cache:", err.message);
  }
}

/** Reset in-memory state (for testing). */
function _resetForTest() {
  _cache = null;
  _dirty = false;
}

module.exports = {
  getHistoricalPrice,
  setHistoricalPrice,
  flushPriceCache,
  toUtcDayKey,
  _resetForTest,
  _CACHE_PATH,
};
