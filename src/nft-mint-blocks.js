/**
 * @file src/nft-mint-blocks.js
 * @module nftMintBlocks
 * @description
 * Derives each NFT's mint block from a rebalance chain, so a per-NFT
 * log scan can start at the block that NFT came into existence instead
 * of at the pool's creation block.
 *
 * **Why this matters.** An NFT cannot emit `IncreaseLiquidity`,
 * `Collect` or `DecreaseLiquidity` before the block it was minted in —
 * it does not exist yet. Scanning it from pool creation therefore walks
 * millions of blocks that provably hold nothing for that token.
 *
 * That waste was invisible while log queries ran unpaced. Once every
 * RPC request went through the global 250 ms queue, a cold-cache
 * lifetime scan of a three-NFT chain became roughly ten thousand paced
 * requests — about three quarters of an hour, during which the scan
 * owned the queue and the bot's own poll-cycle reads waited behind it.
 * Bounding each NFT to its own life cuts that to the handful of chunks
 * each NFT was actually alive for.
 *
 * Pure: no RPC, no files, no logging. The block numbers come from the
 * rebalance events the caller already has.
 */

"use strict";

/**
 * Map each NFT in a rebalance chain to the block it was minted in.
 *
 * A rebalance event records the mint of its `newTokenId` at
 * `blockNumber`, so the chain yields a floor for every NFT except the
 * very first — which appears only as an `oldTokenId` and whose mint
 * predates the chain. Callers fall back to the pool's creation block
 * for that one.
 *
 * Where an id somehow appears more than once, the EARLIEST block wins.
 * A floor that is too high silently loses events; too low only costs
 * time.
 *
 * @param {Array<{newTokenId?: string|number, blockNumber?: number}>} events
 *   Rebalance events, in any order.
 * @returns {Map<string, number>}  tokenId (as a string) → mint block.
 */
function mintBlocksByTokenId(events) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    if (!e || typeof e.blockNumber !== "number" || e.blockNumber < 0) continue;
    if (e.newTokenId === undefined || e.newTokenId === null) continue;
    const id = String(e.newTokenId);
    const prev = out.get(id);
    if (prev === undefined || e.blockNumber < prev) out.set(id, e.blockNumber);
  }
  return out;
}

/**
 * The block a per-NFT scan should start at.
 *
 * @param {Map<string, number>} mintBlocks  From `mintBlocksByTokenId`.
 * @param {string|number} tokenId
 * @param {number} fallbackBlock  Used when the NFT's mint is not in the
 *   chain — normally the pool's creation block.
 * @returns {number}
 */
function scanFloorFor(mintBlocks, tokenId, fallbackBlock) {
  const known =
    mintBlocks instanceof Map ? mintBlocks.get(String(tokenId)) : undefined;
  return typeof known === "number" ? known : fallbackBlock;
}

/**
 * The block one NFT's event scan should start at, given a floor shared
 * by the whole chain.
 *
 * The shared floor is the pool's creation block on a first run, or a
 * checkpoint from a previous scan when resuming. `Math.max` is what
 * makes both correct with one rule: a later mint block tightens a
 * pool-creation floor, and a later checkpoint beats an earlier mint
 * block so a resume never re-walks ground it already covered.
 *
 * Every loop that scans a chain of NFTs must go through this. Four such
 * loops existed and three of them started every NFT at the shared
 * floor, which on a long chain is the dominant cost of the whole scan.
 *
 * @param {Map<string, number>} mintBlocks  From `mintBlocksByTokenId`.
 * @param {string|number} tokenId
 * @param {number} sharedFloor  Pool creation block, or resume checkpoint.
 * @returns {number}
 */
function nftScanFrom(mintBlocks, tokenId, sharedFloor) {
  /*- A non-finite floor would make `Math.max` return NaN, and
   *  `chunkRanges` answers an empty window list for a non-finite
   *  bound — so the scan would find nothing and report it as "no
   *  events" rather than as a failure.  Falling back to 0 can only
   *  widen the scan, never narrow it, so it cannot hide data. */
  const floor = Number.isFinite(sharedFloor) ? sharedFloor : 0;
  return Math.max(floor, scanFloorFor(mintBlocks, tokenId, 0));
}

module.exports = { mintBlocksByTokenId, scanFloorFor, nftScanFrom };
