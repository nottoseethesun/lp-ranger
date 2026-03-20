/**
 * @file src/epoch-cache.js
 * @module epochCache
 * @description
 * Disk-backed JSON cache for reconstructed P&L epochs.  Keyed by a
 * hierarchical path: `blockchain / wallet / nftContract / tokenId`,
 * mirroring the client-side URL structure.  Currently only PulseChain
 * is supported, but the key structure is designed for multi-chain use.
 *
 * Cache file: `.epoch-cache.json` (gitignored).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const _CACHE_PATH = path.join(process.cwd(), '.epoch-cache.json');

/** Read the full cache from disk. */
function _readCache() {
  try {
    return JSON.parse(fs.readFileSync(_CACHE_PATH, 'utf8'));
  } catch { return {}; }
}

/** Write the full cache to disk. */
function _writeCache(data) {
  try {
    fs.writeFileSync(_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[epoch-cache] Could not write cache:', err.message);
  }
}

/**
 * Build the cache key path for a position.
 * @param {object} opts
 * @param {string} [opts.blockchain]  Chain name (default: 'pulsechain').
 * @param {string} opts.wallet        Wallet address.
 * @param {string} opts.contract      NFT contract (position manager) address.
 * @param {string} opts.tokenId       NFT token ID.
 * @returns {string} Dot-separated key.
 */
function _cacheKey({ blockchain, wallet, contract, tokenId }) {
  const chain = (blockchain || 'pulsechain').toLowerCase();
  return [chain, wallet.toLowerCase(), contract.toLowerCase(), String(tokenId)].join('.');
}

/**
 * Look up cached closed epochs for a position.
 * @param {object} keyOpts  Options for _cacheKey.
 * @returns {object[]|null}  Cached closed epochs, or null if not found.
 */
function getCachedEpochs(keyOpts) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  const entry = cache[key];
  if (entry && Array.isArray(entry.closedEpochs)) return entry.closedEpochs;
  return null;
}

/**
 * Save closed epochs to the cache for a position.
 * @param {object}   keyOpts        Options for _cacheKey.
 * @param {object[]} closedEpochs   Array of closed Epoch objects.
 */
function setCachedEpochs(keyOpts, closedEpochs) {
  const cache = _readCache();
  const key = _cacheKey(keyOpts);
  cache[key] = { closedEpochs, cachedAt: new Date().toISOString() };
  _writeCache(cache);
}

module.exports = { getCachedEpochs, setCachedEpochs };
