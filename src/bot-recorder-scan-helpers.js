/**
 * @file src/bot-recorder-scan-helpers.js
 * @module bot-recorder-scan-helpers
 * @description
 * Small extracted helpers for `bot-recorder._scanLifetimePoolData` — kept in
 * a separate file so `bot-recorder.js` stays under the 500-line cap.
 */

"use strict";

const { log } = require("./log");
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
 * NFT across ~133 NFTs, three queries each, every one paced — the best
 * part of a day, nearly all of it scanning blocks where the NFT in
 * question did not yet exist.
 *
 * `nftScanFrom` owns how the two floors combine, including the
 * resume case; see `src/nft-mint-blocks.js`.
 *
 * Every NFT scans to the chain head.  There is no sound upper bound:
 * one would have to come from the app's inferred succession, and that
 * inference reads consecutive mints as successive rebalances — true
 * only when every mint in the pool IS a rebalance.  A dust mint from a
 * failed or partial rebalance is indistinguishable in the Transfer log,
 * so the NFT it appears to replace can still be funded and drain later.
 * Bounding on that inference truncates the scan and loses the drain.
 *
 * @param {Set<string>|string[]} ids
 * @param {number} fromBlock  Shared floor: pool creation, or a resume
 *   checkpoint.
 * @param {Map<string, number>} [mintBlocks]  tokenId → mint block, from
 *   `nft-mint-blocks.mintBlocksByTokenId`.
 * @param {object} [opts]
 * @param {Map<string, {from: number, ev: object}>} [opts.resumeBuffer]
 *   Per-NFT reads carried over from an attempt that threw part-way, so
 *   the retry pays only for what is left.  Omit to scan everything.
 * @param {string|number|null} [opts.liveTokenId]  The position's current
 *   NFT, which is neither reused from nor written to the buffer.
 * @returns {Promise<{allNftEvents: Map<string, object>, maxBlock: number}>}
 */
async function fetchAllNftEvents(ids, fromBlock, mintBlocks, opts = {}) {
  const { resumeBuffer = null, liveTokenId = null } = opts;
  const allNftEvents = new Map();
  let maxBlock = fromBlock;
  let reused = 0;
  for (const tid of ids) {
    const from = nftScanFrom(mintBlocks, tid, fromBlock);
    /*- Reuse is exact only when both hold:
     *
     *  The NFT is retired. The live one keeps emitting, and the chain
     *  head advances between a failed attempt and the retry 30 minutes
     *  later, so a buffered read of it would be short by that window.
     *
     *  The floor matches. A buffered read taken from a different
     *  `fromBlock` covers a different span — wider double-counts into
     *  the aggregates, narrower drops events — and the floor moves with
     *  the resume checkpoint and with `fullRescan`. */
    const hit = resumeBuffer instanceof Map ? resumeBuffer.get(tid) : undefined;
    const isLive =
      liveTokenId !== undefined &&
      liveTokenId !== null &&
      String(tid) === String(liveTokenId);
    const reusable = hit !== undefined && hit.from === from && !isLive;
    if (reusable) reused++;
    const ev = reusable
      ? hit.ev
      : await scanNftEvents(tid, { fromBlock: from });
    allNftEvents.set(tid, ev);
    /*- Stored after the scan resolved, so a throw leaves this NFT out
     *  and the next attempt fetches it again.
     *
     *  The live NFT is never stored, not merely never reused. It retires
     *  at the next rebalance, and from that moment `isLive` is false and
     *  the entry looks reusable — but it was read while the NFT was
     *  still open, so it predates the drain that retired it. Reusing it
     *  would drop that NFT's closing Collect and DecreaseLiquidity and
     *  understate its lifetime fees. Only inert NFTs belong here. */
    if (resumeBuffer instanceof Map && !isLive)
      resumeBuffer.set(tid, { from, ev });
    for (const e of [...ev.ilEvents, ...ev.collectEvents, ...ev.dlEvents]) {
      if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
    }
  }
  /*- One line after the fact, not one per NFT: on a long chain the
   *  per-NFT form would bury the scan's own progress output.
   *
   *  Silent when nothing was reused, so its presence means the resume
   *  actually did something. Without it, reuse shows up only as the
   *  ABSENCE of `compounder …` progress lines for those NFTs, which
   *  reads the same as a scan that had no work to do. */
  if (reused > 0)
    log.info(
      "[bot] Lifetime scan resumed: %d of %d NFT read(s) taken from the buffer, %d re-fetched",
      reused,
      allNftEvents.size,
      allNftEvents.size - reused,
    );
  return { allNftEvents, maxBlock };
}

module.exports = { collectTokenIds, fetchAllNftEvents };
