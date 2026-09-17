/**
 * @file src/position-details-lifetime-scan.js
 * @module position-details-lifetime-scan
 * @description
 * Lifetime-HODL computation for closed/unmanaged positions, extracted from
 * `position-details.js` to keep that file under the 500-line cap.  Runs the
 * HODL accumulator over the request's shared chain read
 * (`position-details-chain-read.js`) and owns the per-pool cache
 * persistence.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const {
  setCachedLifetimeHodl,
  setCachedFreshDeposits,
  getCachedFreshDeposits,
} = require("./epoch-cache");
const { eventsFor } = require("./nft-events-batch");
const { collectTokenIds } = require("./bot-recorder-scan-helpers");
const { computeLifetimeHodl } = require("./lifetime-hodl");

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
 * Takes the NFT events for every tokenId in the rebalance chain from the
 * request's shared chain read, runs the HODL accumulator, and persists the
 * result.
 *
 * @param {object} position
 * @param {object[]} events       Rebalance events
 * @param {object} body           Request body with `walletAddress`
 * @param {string} poolAddress    Pool contract address (can be falsy)
 * @param {string|null} poolCacheKey
 * @param {() => Promise<Map<string, object>>} readChainEvents  The
 *   request's chain reader, from `chainEventsReader`.
 * @returns {Promise<object>}     HODL result from `computeLifetimeHodl`.
 */
async function scanLifetimeHodl(
  position,
  events,
  body,
  poolAddress,
  poolCacheKey,
  readChainEvents,
) {
  const batch = await readChainEvents();
  /*-
   *  Looked up per NFT rather than handed over whole: `eventsFor` throws
   *  for an NFT the read did not cover, where the accumulator would
   *  skip a missing one as "no deposits" and understate the HODL.
   */
  const allNftEvents = new Map();
  const ids = collectTokenIds(position, events);
  for (const tid of ids) {
    const nftEvents = eventsFor(batch, tid);
    allNftEvents.set(tid, nftEvents);
  }
  const cachedFresh = poolCacheKey
    ? getCachedFreshDeposits(poolCacheKey)
    : null;
  const provider = sendTx.getManagedReadProvider();
  const hodl = await computeLifetimeHodl(allNftEvents, {
    rebalanceEvents: events,
    position,
    provider,
    ethersLib: ethers,
    walletAddress: body.walletAddress,
    excludeFromAddrs: [config.POSITION_MANAGER, poolAddress],
    wrappedNativeAddress: config.CHAIN.nativeWrappedToken,
    cachedFreshDeposits: cachedFresh,
  });
  _persistLifetimeHodlCache(poolCacheKey, hodl, cachedFresh);
  return hodl;
}

module.exports = { scanLifetimeHodl };
