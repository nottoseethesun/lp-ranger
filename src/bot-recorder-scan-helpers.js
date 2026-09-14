/**
 * @file src/bot-recorder-scan-helpers.js
 * @module bot-recorder-scan-helpers
 * @description
 * Small extracted helpers for `bot-recorder._scanLifetimePoolData` — kept in
 * a separate file so `bot-recorder.js` stays under the 500-line cap.
 */

"use strict";

const { scanNftEvents } = require("./compounder");
const { nftScanFrom } = require("./nft-mint-blocks");

/**
 * Collect all unique tokenIds from the rebalance chain plus the current
 * position.  Returned as a Set of stringified ids.
 * @param {object} position         Current position with `tokenId`.
 * @param {object[]} rebalanceEvents Optional rebalance event array.
 * @returns {Set<string>}
 */
function collectTokenIds(position, rebalanceEvents) {
  const ids = new Set([String(position.tokenId)]);
  for (const ev of rebalanceEvents || []) {
    if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
    if (ev.newTokenId) ids.add(String(ev.newTokenId));
  }
  return ids;
}

/**
 * Fetch IncreaseLiquidity / Collect / DecreaseLiquidity events for every
 * tokenId in `ids`, tracking the highest block seen so the caller can
 * persist an incremental-scan checkpoint.
 *
 * **Each NFT is scanned from its own mint block**, not from one floor
 * shared by the whole chain. An NFT cannot emit these events before it
 * exists, so the blocks before its mint are a guaranteed-empty walk —
 * and on a long chain that walk dominates everything else. Observed on
 * a 132-rebalance position whose pool predated the operator's first
 * deposit by two years: at the 9,000-block chunk width, 954 chunks per
 * NFT across ~133 NFTs, three queries each, paced at 250 ms — the best
 * part of a day, nearly all of it scanning blocks where the NFT in
 * question did not yet exist.
 *
 * `nftScanFrom` owns how the two floors combine, including the
 * resume case; see `src/nft-mint-blocks.js`.
 *
 * @param {Set<string>|string[]} ids
 * @param {number} fromBlock  Shared floor: pool creation, or a resume
 *   checkpoint.
 * @param {Map<string, number>} [mintBlocks]  tokenId → mint block, from
 *   `nft-mint-blocks.mintBlocksByTokenId`.
 * Every NFT scans to the chain head.  There is no sound upper bound:
 * one would have to come from the app's inferred succession, and that
 * inference reads consecutive mints as successive rebalances — true
 * only when every mint in the pool IS a rebalance.  A dust mint from a
 * failed or partial rebalance is indistinguishable in the Transfer log,
 * so the NFT it appears to replace can still be funded and drain later.
 * Bounding on that inference truncates the scan and loses the drain.
 *
 * @returns {Promise<{allNftEvents: Map<string, object>, maxBlock: number}>}
 */
async function fetchAllNftEvents(ids, fromBlock, mintBlocks) {
  const allNftEvents = new Map();
  let maxBlock = fromBlock;
  for (const tid of ids) {
    const ev = await scanNftEvents(tid, {
      fromBlock: nftScanFrom(mintBlocks, tid, fromBlock),
    });
    allNftEvents.set(tid, ev);
    for (const e of [...ev.ilEvents, ...ev.collectEvents, ...ev.dlEvents]) {
      if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
    }
  }
  return { allNftEvents, maxBlock };
}

module.exports = { collectTokenIds, fetchAllNftEvents };
