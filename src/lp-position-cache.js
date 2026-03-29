/**
 * @file lp-position-cache.js
 * @module lpPositionCache
 * @description
 * Disk-backed cache for LP position enumeration results.  Stores immutable
 * position data (tokenId, token0/token1, fee, ticks, symbols) plus mutable
 * liquidity, with a `lastBlock` cursor for freshness checks.
 *
 * On restart, the cache lets the LP Browser display positions instantly.
 * A lightweight freshness check (Transfer + IncreaseLiquidity +
 * DecreaseLiquidity events since lastBlock) determines whether a full
 * re-enumeration is needed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const _C = '\x1b[38;5;118;48;5;94m';
const _R = '\x1b[0m';

/**
 * Build deterministic cache file path for a wallet's LP positions.
 * @param {string} walletAddress  Checksummed 0x-prefixed address.
 * @returns {string}  Absolute path, e.g. tmp/lp-position-cache-4e4484.json
 */
function lpPositionCachePath(walletAddress) {
  const prefix = walletAddress.slice(2, 8).toLowerCase();
  return path.join(process.cwd(), 'tmp', `lp-position-cache-${prefix}.json`);
}

/**
 * Load cached LP positions from disk.
 * @param {string} walletAddress
 * @param {object} [opts]
 * @param {object} [opts.fsModule]  Injected fs for testing.
 * @returns {{ positions: object[], lastBlock: number } | null}
 */
function loadLpPositionCache(walletAddress, opts) {
  const _fs = (opts && opts.fsModule) || fs;
  try {
    const raw = _fs.readFileSync(lpPositionCachePath(walletAddress), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.positions) && typeof data.lastBlock === 'number') {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save LP positions to disk cache with block cursor.
 * @param {string} walletAddress
 * @param {object[]} positions  Array of position objects.
 * @param {number} lastBlock  Block number at time of scan/check.
 * @param {object} [opts]
 * @param {object} [opts.fsModule]  Injected fs for testing.
 */
function saveLpPositionCache(walletAddress, positions, lastBlock, opts) {
  const _fs = (opts && opts.fsModule) || fs;
  const filePath = lpPositionCachePath(walletAddress);
  const dir = path.dirname(filePath);
  try {
    _fs.mkdirSync(dir, { recursive: true });
    _fs.writeFileSync(
      filePath,
      JSON.stringify({ positions, lastBlock }, (_k, v) =>
        typeof v === 'bigint' ? String(v) : v, 2),
      'utf8',
    );
  } catch (err) {
    console.warn(_C + '[lp-cache] Failed to persist cache: ' + err.message + _R);
  }
}

/**
 * Delete the LP position cache for a wallet.  Called after rebalance
 * mints a new NFT (tokenId list changed, balance didn't).
 * @param {string} walletAddress
 * @param {object} [opts]
 * @param {object} [opts.fsModule]  Injected fs for testing.
 */
function clearLpPositionCache(walletAddress, opts) {
  const _fs = (opts && opts.fsModule) || fs;
  try {
    _fs.unlinkSync(lpPositionCachePath(walletAddress));
  } catch {
    /* file may not exist */
  }
}

/**
 * Check whether any position-affecting events occurred since lastBlock.
 * Queries Transfer (ownership), IncreaseLiquidity, and DecreaseLiquidity
 * events on the NonfungiblePositionManager.  Returns true if ANY activity
 * is found — caller should invalidate the cache and do a full rescan.
 *
 * @param {object} contract  ethers Contract bound to NonfungiblePositionManager.
 * @param {string} walletAddress  Checksummed wallet address.
 * @param {string[]} cachedTokenIds  TokenIds from the cached positions.
 * @param {number} fromBlock  Start of range (lastBlock + 1).
 * @param {number} toBlock  End of range (current block).
 * @returns {Promise<boolean>}  True if any activity detected.
 */
async function hasPositionActivitySince(
  contract,
  walletAddress,
  cachedTokenIds,
  fromBlock,
  toBlock,
) {
  if (fromBlock > toBlock) return false;

  const tokenIdTopics = cachedTokenIds.map((id) =>
    '0x' + BigInt(id).toString(16).padStart(64, '0'),
  );

  const queries = [
    contract.queryFilter(
      contract.filters.Transfer(walletAddress, null),
      fromBlock,
      toBlock,
    ),
    contract.queryFilter(
      contract.filters.Transfer(null, walletAddress),
      fromBlock,
      toBlock,
    ),
  ];

  if (tokenIdTopics.length > 0) {
    queries.push(
      contract.queryFilter(
        contract.filters.IncreaseLiquidity(tokenIdTopics),
        fromBlock,
        toBlock,
      ),
      contract.queryFilter(
        contract.filters.DecreaseLiquidity(tokenIdTopics),
        fromBlock,
        toBlock,
      ),
    );
  }

  const results = await Promise.all(queries);
  return results.some((events) => events.length > 0);
}

module.exports = {
  lpPositionCachePath,
  loadLpPositionCache,
  saveLpPositionCache,
  clearLpPositionCache,
  hasPositionActivitySince,
};
