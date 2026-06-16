/**
 * @file src/price-cache.js
 * @module priceCache
 * @description
 * Disk-backed JSON cache for immutable historical token prices.
 * Keyed by `blockchain-tokenAddress-YYYY-MM-DDTHH:MM` (UTC, minute granularity).
 * Token prices are pool-independent — cached by token contract address, not pool.
 *
 * Cache file: `tmp/historical-price-cache.json` (gitignored).
 * Deleted by `npm run clean`; preserved by `npm run dev-clean`.
 *
 * No TTL — historical prices never change.  Lazy-loaded on first access.
 * Batched writes via dirty flag: `set` marks dirty, `flush` writes only if needed.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");

// Cache path can be overridden via env var so tests cannot ever clobber the
// production file, regardless of how the test is invoked.
const _CACHE_PATH =
  process.env.PRICE_CACHE_PATH ||
  path.join(process.cwd(), "tmp", "historical-price-cache.json");

/** @type {Record<string, { priceUsd: number, cachedAt: string }> | null} */
let _cache = null;
let _dirty = false;

/** Read the full cache from disk (lazy, once). */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    _cache = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch {
    _cache = {};
  }
  _migrateBlockKeys();
}

/**
 * One-time migration: strip date prefix from block-scoped keys.
 * Old format: `chain-token-YYYY-MM-DDTHH:MM@blockNumber`
 * New format: `chain-token-@blockNumber`
 * On collision (same block cached on multiple dates), keep the earliest
 * `cachedAt` entry — it is most likely the original historical fetch
 * rather than a same-day current-price fallback.
 */
function _migrateBlockKeys() {
  const re = /^(.+)-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(@\d+)$/;
  let migrated = 0;
  for (const oldKey of Object.keys(_cache)) {
    const m = oldKey.match(re);
    if (!m) continue;
    const newKey = `${m[1]}-${m[2]}`;
    const oldEntry = _cache[oldKey];
    const existing = _cache[newKey];
    if (!existing || (oldEntry.cachedAt || "") < (existing.cachedAt || "")) {
      _cache[newKey] = oldEntry;
    }
    delete _cache[oldKey];
    migrated++;
  }
  if (migrated > 0) {
    log.info("[price-cache] Migrated %d block-scoped keys", migrated);
    _dirty = true;
  }
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

/** Write the cache to disk if any new prices were added since last flush. */
function flushPriceCache() {
  if (!_dirty || !_cache) return;
  try {
    fs.mkdirSync(path.dirname(_CACHE_PATH), { recursive: true });
    fs.writeFileSync(_CACHE_PATH, JSON.stringify(_cache, null, 2), "utf8");
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
