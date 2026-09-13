"use strict";

const { scanChunked } = require("./get-logs-chunked");

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
 * @param {number} [opts.chunkSize] - Block range per query.  Defaults to
 *   `getLogsChunkSize` (7,500).  Do not widen it on the grounds that
 *   `PoolCreated` events are rare: endpoints cap `eth_getLogs` on the
 *   block span, not on the result count, and reject anything above
 *   10,000 blocks whatever the filter matches.
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
    chunkSize,
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
    let found = null;
    /*- Scanned newest-first.  Callers pass `fromBlock: 0`, so an
     *  oldest-first walk grinds through the entire chain before
     *  reaching a pool created last week — and every pool LP Ranger
     *  manages was, by definition, created before now and usually
     *  recently.  Reversing turns the common case into a handful of
     *  windows while leaving the worst case (a genuinely ancient pool)
     *  exactly as it was.
     *
     *  Best-effort: a window that fails is skipped rather than failing
     *  the lookup, preserving the previous behaviour of falling back to
     *  a full scan when the factory query does not cooperate. */
    await scanChunked({
      fromBlock,
      toBlock,
      chunkSize,
      direction: "desc",
      signal,
      onProgress,
      bestEffort: true,
      /*- Names the pool it is looking for.  Two of these run at once on
       *  a cold cache — one per managed position — and an unlabelled
       *  line leaves two interleaved progress sequences that cannot be
       *  told apart.
       *
       *  The address is written in full, and called a Pool i.d. rather
       *  than abbreviated like a tx hash: this identifies the pool
       *  contract itself, so it is the thing an operator pastes into an
       *  explorer or greps the log for. */
      label: `pool-creation for Pool i.d. ${poolAddress}`,
      query: (f, t) => factory.queryFilter(factory.filters.PoolCreated(), f, t),
      onChunk: (events) => {
        for (const ev of events) {
          const createdPool = ev.args[4] || ev.args.pool;
          if (createdPool && createdPool.toLowerCase() === poolLower) {
            found = ev.blockNumber;
            return true;
          }
        }
        return false;
      },
    });
    if (found !== null) return found;
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
