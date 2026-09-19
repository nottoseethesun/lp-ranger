/**
 * @file src/epoch-cache.js
 * @module epochCache
 * @description
 * Disk-backed JSON cache for reconstructed P&L epochs.  Keyed by pool
 * identity, `blockchain.contract.wallet.token0.token1.fee` (`_cacheKey`),
 * so a position's history survives the new NFT every rebalance mints.
 * Each entry also holds the lifetime HODL amounts and fresh-deposit
 * totals, written by the bot's lifetime scan and by the unmanaged
 * details view.
 *
 * Cache file: `tmp/pnl-epochs-cache.json` (gitignored).
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");

let _CACHE_PATH = path.join(process.cwd(), "tmp", "pnl-epochs-cache.json");

/** Read the full cache from disk. */
function _readCache() {
  try {
    return JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Write the full cache to disk. */
function _writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(_CACHE_PATH), { recursive: true });
    fs.writeFileSync(_CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    log.warn("[epoch-cache] Could not write cache:", err.message);
  }
}

/**
 * Build the cache key for a pool.
 * @param {object} opts
 * @param {string} [opts.blockchain]  Chain name (default: 'pulsechain').
 * @param {string} [opts.contract]    NFT factory/position manager address.
 * @param {string} opts.wallet   Wallet address.
 * @param {string} opts.token0   Pool token0 address.
 * @param {string} opts.token1   Pool token1 address.
 * @param {number|string} opts.fee  Pool fee tier.
 * @returns {string} Dot-separated key.
 */
function _cacheKey({ blockchain, contract, wallet, token0, token1, fee }) {
  return [
    (blockchain || "pulsechain").toLowerCase(),
    (contract || "").toLowerCase(),
    (wallet || "").toLowerCase(),
    token0.toLowerCase(),
    token1.toLowerCase(),
    String(fee),
  ].join(".");
}

/**
 * Look up cached P&L tracker state for a position.
 * @param {object} keyOpts  Options for _cacheKey.
 * @returns {object|null}  Tracker state ({ closedEpochs, liveEpoch }), or null.
 */
function getCachedEpochs(keyOpts) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  const entry = cache[key];
  if (!entry) return null;
  // Support both formats: full tracker state or legacy closedEpochs-only
  if (entry.closedEpochs && entry.closedEpochs.closedEpochs)
    return entry.closedEpochs; // full tracker state wrapped
  if (Array.isArray(entry.closedEpochs))
    return {
      closedEpochs: entry.closedEpochs,
      liveEpoch: entry.liveEpoch || null,
    };
  return null;
}

/**
 * Save P&L tracker state to the cache for a position.
 *
 * Pass a full tracker state — `tracker.serialize()`. Every caller does.
 *
 * A bare array is also accepted, and asserts something: that there is no
 * live epoch. It stores `null` for one. That is destructive to say by
 * accident, because the live epoch holds gas, gas only accumulates, and
 * nothing can re-derive it — so a `null` written in passing erases a
 * period's cost permanently. Pass an array only to mean it.
 *
 * @param {object}         keyOpts  Options for _cacheKey.
 * @param {object|object[]} data    Tracker state, or a closedEpochs
 *   array to store with no live epoch.
 */
function setCachedEpochs(keyOpts, data) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  const value = Array.isArray(data)
    ? { closedEpochs: data, liveEpoch: null }
    : data;
  /* Never lose historical epochs — if the existing cache has more
     closed epochs than the incoming data, prepend the missing ones.
     This prevents a fresh tracker (1 epoch after rebalance) from
     overwriting the full reconstructed history. */
  const existing = cache[key];
  const existingEpochs = existing?.closedEpochs || [];
  const incomingEpochs = value.closedEpochs || [];
  if (existingEpochs.length > incomingEpochs.length) {
    const missing = existingEpochs.slice(
      0,
      existingEpochs.length - incomingEpochs.length,
    );
    value.closedEpochs = [...missing, ...incomingEpochs];
  }
  /*-
   *  Merge — do NOT replace. The entry also holds `lifetimeHodlAmounts`
   *  and `freshDeposits`, written by the lifetime scans. A naked
   *  `cache[key] = {...value, cachedAt}` silently wipes those siblings
   *  every time epochs are persisted, which breaks the lifetime-deposit
   *  UI. Preserve the existing entry and only overwrite the epoch-shaped
   *  keys.
   */
  cache[key] = {
    ...(existing || {}),
    ...value,
    cachedAt: new Date().toISOString(),
  };
  _writeCache(cache);
}

/**
 * Read cached lifetime HODL amounts for a pool.
 * @param {object} keyOpts  Options for _cacheKey.
 * @returns {{ amount0: number, amount1: number }|null}
 */
function getCachedLifetimeHodl(keyOpts) {
  const cache = _readCache();
  const entry = cache[_cacheKey(keyOpts)];
  return entry?.lifetimeHodlAmounts || null;
}

/**
 * Save lifetime HODL amounts for a pool.
 * @param {object} keyOpts  Options for _cacheKey.
 * @param {{ amount0: number, amount1: number }} hodl
 */
function setCachedLifetimeHodl(keyOpts, hodl) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  cache[key] = { ...(cache[key] || {}), lifetimeHodlAmounts: hodl };
  _writeCache(cache);
}

/**
 * Read cached fresh deposit totals for a pool.
 * @param {object} keyOpts  Options for _cacheKey.
 * @returns {{ raw0: string, raw1: string, lastBlock: number,
 *   deposits: object[] }|null}  raw0/raw1 are BigInt-as-string for
 *   lossless storage. `lastBlock` is the newest mint whose window has
 *   been scanned, so a later scan covers only what came after it.
 *   `deposits` is the per-deposit list the lifetime deposit total is
 *   built from; each entry keeps the dollar figure it was last given.
 */
function getCachedFreshDeposits(keyOpts) {
  const cache = _readCache();
  const entry = cache[_cacheKey(keyOpts)];
  return entry?.freshDeposits || null;
}

/**
 * Save fresh deposit totals for a pool.
 * @param {object} keyOpts  Options for _cacheKey.
 * @param {{ raw0: string, raw1: string, lastBlock: number }} data
 */
function setCachedFreshDeposits(keyOpts, data) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  cache[key] = { ...(cache[key] || {}), freshDeposits: data };
  _writeCache(cache);
}

/**
 * Delete every field cached under a pool's key (closedEpochs,
 * liveEpoch, lifetimeHodlAmounts, freshDeposits).
 * Used by the "Reload Current Position" endpoint to reset a position's
 * on-chain-derived state so the next scan starts from pool creation
 * with no stale data merged in.  No-op when the key is not present.
 * @param {object} keyOpts  Options for _cacheKey.
 */
function clearCacheEntry(keyOpts) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  if (!cache[key]) return;
  delete cache[key];
  _writeCache(cache);
}

/** Override cache file path (test isolation only). */
function _setCachePath(p) {
  _CACHE_PATH = p;
}

module.exports = {
  getCachedEpochs,
  setCachedEpochs,
  getCachedLifetimeHodl,
  setCachedLifetimeHodl,
  getCachedFreshDeposits,
  setCachedFreshDeposits,
  clearCacheEntry,
  _setCachePath,
};
