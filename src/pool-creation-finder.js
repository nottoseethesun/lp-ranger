"use strict";

/**
 * @file pool-creation-finder.js
 * @module poolCreationFinder
 * @description
 * Finds the block a V3 pool was deployed in, by binary search on
 * `eth_getCode`.
 *
 * Contract code is account state, and state is addressable per block, so
 * "does this pool exist at block N" is one `eth_getCode` call. The lowest
 * block that answers yes is the deployment block. Over a 27.5M-block chain
 * that is ~25 calls.
 *
 * The alternative — scanning the Factory's `PoolCreated` log — cannot be
 * bisected, because those events are ordered by block and not by pool
 * address, so finding one pool means reading every event until it appears.
 * On this chain that is 900-1,100 chunked `eth_getLogs` queries for a pool
 * a few years old, all of them paced by the global RPC queue.
 *
 * **Requires historical state.** A node that has pruned it answers with an
 * error ("missing trie node" / "historical state unavailable"), not with an
 * empty result, so a pruned endpoint cannot produce a wrong block — the
 * error propagates to `getPoolCreationBlockCached`, which returns 0 and
 * leaves the caller on its own lower bound.
 *
 * Most callers should use `getPoolCreationBlockCached` from
 * `pool-creation-block.js` rather than this primitive — the cached resolver
 * memoises in-process and persists to disk, so the lookup is paid at most
 * once per pool ever.
 */

/**
 * Whether an address holds contract code at a given block.
 * @param {object} provider      ethers.js provider.
 * @param {string} address       Contract address.
 * @param {number} blockTag      Block number to read state at.
 * @returns {Promise<boolean>}
 */
async function _hasCodeAt(provider, address, blockTag) {
  const code = await provider.getCode(address, blockTag);
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

/** Throw the shared AbortError shape when the caller has cancelled. */
function _throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Pool-creation lookup aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Find the block a V3 pool was deployed in.
 *
 * @param {object} provider          ethers.js provider.
 * @param {object} opts
 * @param {string} opts.poolAddress  The pool to locate.
 * @param {number} [opts.fromBlock=0] Earliest block to consider.
 * @param {number} opts.toBlock      Latest block to consider (the head).
 * @param {function} [opts.onProgress] (done, total) => void.
 * @param {AbortSignal} [opts.signal]  Cancellation.
 * @returns {Promise<number|null>}  Deployment block, or null when the pool
 *   holds no code at `toBlock` (it does not exist on this chain) or the
 *   window is empty.
 * @throws Propagates provider errors — a node without historical state
 *   cannot answer, and guessing would move the caller's scan floor
 *   forward past events it still needs to read.
 */
async function findPoolCreationBlock(provider, opts) {
  const {
    poolAddress,
    fromBlock = 0,
    toBlock,
    onProgress,
    signal,
  } = opts || {};
  if (!provider || !poolAddress || !Number.isFinite(toBlock)) return null;

  let lo = Math.max(0, Math.floor(fromBlock));
  let hi = Math.floor(toBlock);
  if (hi <= lo) return null;

  _throwIfAborted(signal);
  /*- Establish the invariant the search maintains: code at `hi`, none at
   *  `lo`.  Without code at the head there is nothing to find. */
  if (!(await _hasCodeAt(provider, poolAddress, hi))) return null;

  _throwIfAborted(signal);
  /*- Code already at `lo` means the pool predates the window, so `lo` is
   *  the tightest bound this search can honestly return. */
  if (await _hasCodeAt(provider, poolAddress, lo)) return lo;

  const total = Math.max(1, Math.ceil(Math.log2(hi - lo)));
  let done = 0;
  while (hi - lo > 1) {
    _throwIfAborted(signal);
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await _hasCodeAt(provider, poolAddress, mid)) hi = mid;
    else lo = mid;
    done += 1;
    if (onProgress) onProgress(Math.min(done, total), total);
  }
  /*- `hi` is now the lowest block holding code, with `lo === hi - 1`
   *  holding none: the deployment block. */
  if (onProgress) onProgress(total, total);
  return hi;
}

module.exports = {
  findPoolCreationBlock,
};
