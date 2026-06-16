/**
 * @file src/price-fetcher-dedup.js
 * @module price-fetcher-dedup
 * @description
 * In-flight fetch dedup for the current-price cascade.  When N positions
 * sharing the same token (e.g. wPLS, USDT) all enter `fetchTokenPriceUsd`
 * in the same poll tick and miss the cache, only the first call hits the
 * source cascade — the rest await the same Promise.  Without this, the
 * bot logs the same token price fetched N× per batch (thundering-herd
 * problem) and wastes N−1 units of price-source quota per cache-miss
 * tick.
 *
 * Lives in its own module so `src/price-fetcher.js` stays under the 500
 * non-comment-line cap.
 */

"use strict";

const { log } = require("./log");
const { formatToken } = require("./price-source-cascade");
const config = require("./config");

/**
 * In-flight Promise map.  Keys mirror the price cache
 * (`{chain}:{tokenAddress}` lower-cased).
 * @type {Map<string, Promise<number>>}
 */
const _inflight = new Map();

/**
 * Return the in-flight Promise for `key` if one is pending, else `null`.
 * Logs a `[price-fetcher] in-flight dedup ...` line when verbose so
 * operators can confirm a burst was collapsed instead of hitting the
 * source N times.
 *
 * @param {string} key  Cache key.
 * @param {string} [tokenAddress]  Optional, for the verbose log.
 * @returns {Promise<number>|null}
 */
function getInflight(key, tokenAddress) {
  const pending = _inflight.get(key);
  if (!pending) return null;
  if (config.VERBOSE) {
    log.info(
      "[price-fetcher] in-flight dedup %s — awaiting concurrent fetch",
      tokenAddress ? formatToken(tokenAddress) : key,
    );
  }
  return pending;
}

/**
 * Register `promise` as the in-flight fetch for `key` and arrange
 * automatic cleanup when it settles.
 *
 * @param {string} key
 * @param {Promise<number>} promise
 * @returns {Promise<number>} The same promise, returned for chaining.
 */
function trackInflight(key, promise) {
  _inflight.set(key, promise);
  promise.finally(() => _inflight.delete(key));
  return promise;
}

/** Tests only: clear the in-flight map. */
function _resetInflightForTests() {
  _inflight.clear();
}

/** Tests only: number of in-flight entries. */
function _inflightSize() {
  return _inflight.size;
}

/* ── verbose cache-state loggers ─────────────────────────────────────
 *  These keep `price-fetcher.js` under its 500-line cap by collapsing
 *  the 5-line `if (VERBOSE) log.info(...)` blocks at each early-
 *  return path into one-liners.  All are no-ops unless VERBOSE is set,
 *  so the steady-state log only shows real fetches. */

/** Token cache hit (within TTL, no fetch). */
function logCacheHit(tokenAddress, cached) {
  if (!config.VERBOSE) return;
  const ageS = Math.round((Date.now() - cached.ts) / 1000);
  log.info(
    "[price-fetcher] cache hit %s →$%s age=%ds",
    formatToken(tokenAddress),
    cached.price,
    ageS,
  );
}

/** Token paused-and-returning-cached (or 0 on cold cache). */
function logPausedCached(tokenAddress, cached) {
  if (!config.VERBOSE) return;
  const tail = cached ? ` →$${cached.price}` : " (cold cache → 0)";
  log.info(
    "[price-fetcher] paused — returning cached %s%s",
    formatToken(tokenAddress),
    tail,
  );
}

/** Dust-unit-price cache hit. */
function logDustCacheHit(cached) {
  if (!config.VERBOSE) return;
  const ageMin = Math.round((Date.now() - cached.ts) / 60000);
  log.info("[dust-unit-price] cache hit $%s age=%dmin", cached.price, ageMin);
}

/** Dust-unit-price paused-and-returning-cached. */
function logDustPausedCached(cached) {
  if (!config.VERBOSE) return;
  const tail = cached ? `$${cached.price}` : "(cold cache → 0)";
  log.info("[dust-unit-price] paused — returning cached %s", tail);
}

module.exports = {
  getInflight,
  trackInflight,
  logCacheHit,
  logPausedCached,
  logDustCacheHit,
  logDustPausedCached,
  _resetInflightForTests,
  _inflightSize,
};
