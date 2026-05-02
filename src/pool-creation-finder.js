"use strict";

/**
 * @file pool-creation-finder.js
 * @module poolCreationFinder
 * @description
 * Primitive linear scanner for the V3 pool's `PoolCreated` block on the
 * Factory.  Lives in its own module so `pool-creation-block.js` (the
 * disk-cached resolver layered on top) and any other consumer can
 * require it directly without circling back through `event-scanner.js`.
 *
 * Most callers should use `getPoolCreationBlockCached` from
 * `pool-creation-block.js` rather than this primitive — the cached
 * resolver memoises in-process and persists to disk, so the (expensive)
 * Factory scan is paid at most once per pool ever.
 */

const POOL_CREATED_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

/**
 * Throw if an AbortSignal is aborted.  Mirrors the helper in event-scanner.js
 * so this module stays standalone.
 * @param {AbortSignal} [signal]
 * @param {string} where  Short label for the log message.
 */
function _throwIfAborted(signal, where) {
  if (signal && signal.aborted) {
    console.log("[event-scanner] %s aborted via AbortSignal", where);
    const err = new Error("Scan aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Find the block number at which a V3 pool was created by querying the
 * Factory's PoolCreated event.  This lets the scanner skip all blocks before
 * the pool existed, potentially saving thousands of RPC queries.
 *
 * @param {object} provider   - ethers.js provider.
 * @param {object} ethersLib  - ethers library (for Contract).
 * @param {object} opts
 * @param {string} opts.factoryAddress - V3 Factory contract address.
 * @param {string} opts.poolAddress    - The pool address to search for.
 * @param {number} opts.fromBlock      - Earliest block to search from.
 * @param {number} opts.toBlock        - Latest block to search to.
 * @param {number} [opts.chunkSize=50000] - Block range per query (wider since
 *                                          PoolCreated events are rare).
 * @param {function} [opts.onProgress]    - (chunkIdx, totalChunks) => void.
 * @param {AbortSignal} [opts.signal]     - Abort signal for cancellation.
 * @returns {Promise<number|null>} Block number of pool creation, or null.
 */
async function findPoolCreationBlock(provider, ethersLib, opts) {
  const {
    factoryAddress,
    poolAddress,
    fromBlock,
    toBlock,
    chunkSize = 50_000,
    onProgress,
    signal,
  } = opts;
  if (!factoryAddress || !poolAddress) return null;
  try {
    const factory = new ethersLib.Contract(
      factoryAddress,
      POOL_CREATED_ABI,
      provider,
    );
    const poolLower = poolAddress.toLowerCase();
    const totalChunks = Math.ceil((toBlock - fromBlock + 1) / chunkSize);
    let chunkIdx = 0;
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      _throwIfAborted(signal, "findPoolCreationBlock");
      const end = Math.min(start + chunkSize - 1, toBlock);
      if (onProgress) onProgress(chunkIdx, totalChunks);
      try {
        const events = await factory.queryFilter(
          factory.filters.PoolCreated(),
          start,
          end,
        );
        for (const ev of events) {
          const createdPool = ev.args[4] || ev.args.pool;
          if (createdPool && createdPool.toLowerCase() === poolLower)
            return ev.blockNumber;
        }
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        /* skip failed chunks */
      }
      chunkIdx++;
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    /* factory query failed — fall back to full scan */
  }
  return null;
}

module.exports = {
  findPoolCreationBlock,
  POOL_CREATED_ABI,
};
