/**
 * @file src/position-details-lifetime-scan.js
 * @module position-details-lifetime-scan
 * @description
 * Lifetime-HODL on-chain scan for closed/unmanaged positions, extracted from
 * `position-details.js` to keep that file under the 500-line cap.  Owns the
 * NFT-event fetch (bounded by the pool's creation block) and the per-pool
 * cache persistence.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const {
  setCachedLifetimeHodl,
  setCachedFreshDeposits,
  getCachedFreshDeposits,
} = require("./epoch-cache");
const { getPoolCreationBlockCached } = require("./pool-creation-block");
const { scanNftEvents } = require("./compounder");
const { computeLifetimeHodl } = require("./lifetime-hodl");

/** Resolve the NFT-scan lower bound; 0 when the pool address is unknown. */
async function _resolveScanFromBlock(prov, ethers, poolAddress) {
  if (!poolAddress) return 0;
  return getPoolCreationBlockCached({
    provider: prov,
    ethersLib: ethers,
    factoryAddress: config.FACTORY,
    poolAddress,
  });
}

/** Persist HODL + fresh-deposit caches when keyed and present. */
function _persistLifetimeHodlCache(poolCacheKey, hodl, cachedFresh) {
  if (!poolCacheKey) return;
  setCachedLifetimeHodl(poolCacheKey, hodl);
  if (hodl.lastBlock > (cachedFresh?.lastBlock || 0)) {
    setCachedFreshDeposits(poolCacheKey, {
      raw0: hodl.raw0,
      raw1: hodl.raw1,
      lastBlock: hodl.lastBlock,
      deposits: hodl.deposits,
    });
  }
}

/**
 * Run the lifetime-HODL scan for a closed/unmanaged position.
 * Reads NFT events for every tokenId in the rebalance chain (bounded by the
 * pool's creation block on first run), runs the HODL accumulator, and
 * persists the result.
 *
 * @param {object} position
 * @param {object[]} events       Rebalance events
 * @param {object} body           Request body with `tokenId`, `walletAddress`
 * @param {string} poolAddress    Pool contract address (can be falsy)
 * @param {string|null} poolCacheKey
 * @returns {Promise<object>}     HODL result from `computeLifetimeHodl`.
 */
async function scanLifetimeHodl(
  position,
  events,
  body,
  poolAddress,
  poolCacheKey,
) {
  const ids = new Set([String(body.tokenId)]);
  for (const ev of events || []) {
    if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
    if (ev.newTokenId) ids.add(String(ev.newTokenId));
  }
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
  /*- Bound NFT-event scans to the pool's creation block on first run.
      Same pool for every NFT in the chain, so resolve once. */
  const fromBlock = await _resolveScanFromBlock(prov, ethers, poolAddress);
  const allNftEvents = new Map();
  for (const tid of ids) {
    allNftEvents.set(tid, await scanNftEvents(tid, { fromBlock }));
  }
  const cachedFresh = poolCacheKey
    ? getCachedFreshDeposits(poolCacheKey)
    : null;
  const hodl = await computeLifetimeHodl(allNftEvents, {
    rebalanceEvents: events,
    position,
    provider: prov,
    ethersLib: ethers,
    walletAddress: body.walletAddress,
    excludeFromAddrs: [config.POSITION_MANAGER, poolAddress],
    cachedFreshDeposits: cachedFresh,
  });
  _persistLifetimeHodlCache(poolCacheKey, hodl, cachedFresh);
  return hodl;
}

module.exports = { scanLifetimeHodl };
