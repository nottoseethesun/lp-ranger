/**
 * @file src/epoch-cache.js
 * @module epochCache
 * @description
 * Disk-backed JSON cache for reconstructed P&L epochs.  Keyed by a
 * hierarchical path: `blockchain / wallet / nftContract / tokenId`,
 * mirroring the client-side URL structure.  Currently only PulseChain
 * is supported, but the key structure is designed for multi-chain use.
 *
 * Cache file: `tmp/pnl-epochs-cache.json` (gitignored).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const _CACHE_PATH = path.join(process.cwd(), "tmp", "pnl-epochs-cache.json");

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
    console.warn("[epoch-cache] Could not write cache:", err.message);
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
    return { closedEpochs: entry.closedEpochs, liveEpoch: null };
  return null;
}

/**
 * Save P&L tracker state to the cache for a position.
 * Accepts either a full tracker state ({ closedEpochs, liveEpoch })
 * or a plain closedEpochs array (backward compat with epoch-reconstructor).
 * @param {object}         keyOpts  Options for _cacheKey.
 * @param {object|object[]} data    Tracker state or closedEpochs array.
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
  cache[key] = { ...value, cachedAt: new Date().toISOString() };
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
 * Read the last NFT scan block for incremental scanning.
 * @param {object} keyOpts  Options for _cacheKey.
 * @returns {number} Last scanned block, or 0 if not cached.
 */
function getLastNftScanBlock(keyOpts) {
  const cache = _readCache();
  const entry = cache[_cacheKey(keyOpts)];
  return entry?.lastNftScanBlock || 0;
}

/**
 * Save the last NFT scan block.
 * @param {object} keyOpts  Options for _cacheKey.
 * @param {number} block
 */
function setLastNftScanBlock(keyOpts, block) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  cache[key] = { ...(cache[key] || {}), lastNftScanBlock: block };
  _writeCache(cache);
}

module.exports = {
  getCachedEpochs,
  setCachedEpochs,
  getCachedLifetimeHodl,
  setCachedLifetimeHodl,
  getLastNftScanBlock,
  setLastNftScanBlock,
};
