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

/**
 * Raise a pool-level floor to the chain's own first mint.
 *
 * `mintBlocksByTokenId` cannot name a mint block for the OLDEST NFT in
 * a chain: it appears only as an `oldTokenId`, so its mint predates
 * every event. That one NFT therefore falls back to the pool's creation
 * block — which on a pool that existed long before the operator ever
 * deposited is the single most expensive scan in the whole run.
 *
 * The event scanner already resolves that mint as
 * `firstMintBlockNumber` and hangs it on the events array (see
 * `resolveFirstMintWithForeign`, which follows an NFT minted on another
 * wallet back to its true mint). No NFT in the chain can predate it, so
 * it is a sound floor for all of them, and it costs no extra RPC.
 *
 * Observed: pool created at ~18.95M, first deposit at 26.03M — 1,144
 * chunks reduced to about 200.
 *
 * @param {Array & {firstMintBlockNumber?: number}} events  Rebalance
 *   events, as returned by the event scanner.
 * @param {number} poolFloor  Pool creation block, or resume checkpoint.
 * @returns {number}
 */
function chainScanFloor(events, poolFloor) {
  const base = Number.isFinite(poolFloor) ? poolFloor : 0;
  const first = events && events.firstMintBlockNumber;
  return typeof first === "number" && first > base ? first : base;
}

/**
 * Map each retired NFT to the block its replacement was minted.
 *
 * A rebalance drains the old NFT and mints a new one, so the old NFT's
 * last possible event is at or before the block recorded on that
 * rebalance event. After it, the NFT is empty and the app never returns
 * to it — a re-open mints a fresh NFT rather than reviving a drained
 * one.
 *
 * So scanning a retired NFT all the way to the chain head is a
 * guaranteed-empty walk across everything that happened since. On a
 * long chain that is the bulk of the remaining cost even after each
 * scan is given a correct lower bound: a hundred-odd retired NFTs, each
 * re-reading a million blocks it cannot appear in.
 *
 * The current NFT is deliberately absent from this map — it appears
 * only as a `newTokenId` — so it keeps scanning to head, which is
 * right.
 *
 * @param {Array<{oldTokenId?: string|number, blockNumber?: number}>} events
 * @returns {Map<string, number>}  tokenId → block it was replaced at.
 */
function retirementBlocksByTokenId(events) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    if (!e || typeof e.blockNumber !== "number" || e.blockNumber < 0) continue;
    if (e.oldTokenId === undefined || e.oldTokenId === null) continue;
    const id = String(e.oldTokenId);
    const prev = out.get(id);
    /*- LATEST wins, the mirror of `mintBlocksByTokenId` taking the
     *  earliest: an upper bound that is too low silently loses events,
     *  one that is too high only costs time. */
    if (prev === undefined || e.blockNumber > prev) out.set(id, e.blockNumber);
  }
  return out;
}

/**
 * The block one NFT's event scan should stop at.
 *
 * @param {Map<string, number>} retirementBlocks  From
 *   `retirementBlocksByTokenId`.
 * @param {string|number} tokenId
 * @param {number|string} [fallback="latest"]  Used when the NFT was
 *   never retired — i.e. it is the current one.
 * @returns {number|string}
 */
function nftScanTo(retirementBlocks, tokenId, fallback = "latest") {
  const known =
    retirementBlocks instanceof Map
      ? retirementBlocks.get(String(tokenId))
      : undefined;
  return typeof known === "number" ? known : fallback;
}

/**
 * The same window, for a caller that already knows the two blocks.
 *
 * `nftScanFrom` and `nftScanTo` look the bounds up in maps built from a
 * rebalance chain. A caller working one NFT at a time may already have
 * resolved them from somewhere wider than the chain — the rebalance log,
 * or a mint cache — so it needs the rule without the lookup. Same rule,
 * so it lives here rather than being restated at the call site.
 *
 * @param {object} opts
 * @param {number} [opts.mintBlock]        Block the NFT was minted in.
 * @param {number} [opts.retirementBlock]  Block it was replaced at;
 *   omit for the current NFT, which scans to the chain head.
 * @param {number} [opts.sharedFloor]      Pool creation block, or a
 *   resume checkpoint.
 * @returns {{from: number, to: number|string}}
 */
function nftScanWindow({ mintBlock, retirementBlock, sharedFloor } = {}) {
  const floor = Number.isFinite(sharedFloor) ? sharedFloor : 0;
  return {
    from: Math.max(floor, Number.isFinite(mintBlock) ? mintBlock : 0),
    to: Number.isFinite(retirementBlock) ? retirementBlock : "latest",
  };
}

module.exports = {
  mintBlocksByTokenId,
  scanFloorFor,
  nftScanFrom,
  chainScanFloor,
  retirementBlocksByTokenId,
  nftScanTo,
  nftScanWindow,
};
