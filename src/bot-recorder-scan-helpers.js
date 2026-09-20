/**
 * @file src/bot-recorder-scan-helpers.js
 * @module bot-recorder-scan-helpers
 * @description
 * Helpers for the lifetime scan (`_scanLifetimePoolData` in
 * `bot-recorder-lifetime.js`): the token ids in a rebalance chain, and
 * the batched read of their event histories.
 */

"use strict";

const { log } = require("./log");
const { scanChainNftEvents, eventsFor } = require("./nft-events-batch");
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
 * Split a chain into NFTs the resume buffer can answer and NFTs that
 * must be read.
 *
 * Reuse is exact only when both hold:
 *
 * - **The NFT is retired.** The live one keeps emitting, and the chain
 *   head advances between a failed attempt and the retry 30 minutes
 *   later, so a buffered read of it would be short by that window.
 * - **The floor matches.** A buffered read taken from a different floor
 *   covers a different span. Floors can differ between attempts: a
 *   failed pool-creation lookup answers 0, and the retry can find the
 *   real block.
 *
 * @param {string[]} idList
 * @param {Map<string, {from: number, ev: object}>|null} buffer
 * @param {Map<string, number>} floorOf  tokenId -> this run's floor.
 * @param {string|null} liveId  The position's current NFT.
 * @returns {{reusedEv: Map<string, object>, toFetch: string[]}}
 */
function partitionByBuffer(idList, buffer, floorOf, liveId) {
  const reusedEv = new Map();
  const toFetch = [];
  for (const tid of idList) {
    const hit = buffer === null ? undefined : buffer.get(tid);
    const reusable =
      hit !== undefined && hit.from === floorOf.get(tid) && tid !== liveId;
    if (reusable) reusedEv.set(tid, hit.ev);
    else toFetch.push(tid);
  }
  return { reusedEv, toFetch };
}

/**
 * Fetch IncreaseLiquidity / Collect / DecreaseLiquidity events for every
 * tokenId in `ids`.
 *
 * **The whole chain is read in one batched pass** by
 * `nft-events-batch.scanChainNftEvents`, rather than one pass per NFT.
 * Every NFT's window runs from its own mint block to the chain head, so
 * per-NFT passes re-read the same blocks once for each NFT alive in them
 * — on a 132-rebalance chain, tens of thousands of paced requests and
 * hours of wall clock. Filters that OR-match up to 100 token ids each
 * cover the union in about a thousand. The batch re-floors each NFT's
 * logs to its own window afterwards, so what each NFT receives is
 * unchanged.
 *
 * **Each NFT is floored at its own mint block**, both inside the
 * batch and in the resume check below — both through `nftScanFrom`, so
 * the two cannot disagree. An NFT cannot emit these events before it
 * exists. `nftScanFrom` owns how the two floors combine; see
 * `src/nft-mint-blocks.js`.
 *
 * Every NFT scans to the chain head.  There is no sound upper bound:
 * one would have to come from the app's inferred succession, and that
 * inference reads consecutive mints as successive rebalances — true
 * only when every mint in the pool IS a rebalance.  A dust mint from a
 * failed or partial rebalance is indistinguishable in the Transfer log,
 * so the NFT it appears to replace can still be funded and drain later.
 * Bounding on that inference truncates the scan and loses the drain.
 *
 * **The batch succeeds or fails as a unit**, so a failed read buffers
 * nothing and the retry re-reads every NFT not already buffered. That is
 * affordable because the whole chain costs minutes, and because the
 * managed read provider already retries transient failures — timeouts,
 * 5xx, socket resets, rate limiting — beneath this call, so a batch only
 * fails outright on an error a retry would not fix. The buffer still
 * pays for itself when the READ succeeds and a later step of the
 * lifetime scan throws: the retry then re-reads only the live NFT.
 *
 * @param {Set<string>|string[]} ids
 * @param {number} fromBlock  Shared floor: the pool's creation block,
 *   lifted to the chain's first mint.
 * @param {Map<string, number>} [mintBlocks]  tokenId → mint block, from
 *   `nft-mint-blocks.mintBlocksByTokenId`.
 * @param {object} [opts]
 * @param {Map<string, {from: number, ev: object}>} [opts.resumeBuffer]
 *   Per-NFT reads carried over from an attempt that threw part-way, so
 *   the retry pays only for what is left.  Omit to scan everything.
 * @param {string|number|null} [opts.liveTokenId]  The position's current
 *   NFT, which is neither reused from nor written to the buffer.
 * @returns {Promise<Map<string, object>>}  Each NFT's events, keyed by
 *   string tokenId, with an entry for every id in `ids`.
 */
async function fetchAllNftEvents(ids, fromBlock, mintBlocks, opts = {}) {
  const { resumeBuffer = null, liveTokenId = null } = opts;
  const buffer = resumeBuffer instanceof Map ? resumeBuffer : null;
  const liveId =
    liveTokenId !== undefined && liveTokenId !== null
      ? String(liveTokenId)
      : null;
  const idList = [...ids].map(String);
  const floorOf = new Map(
    idList.map((tid) => [tid, nftScanFrom(mintBlocks, tid, fromBlock)]),
  );

  const { reusedEv, toFetch } = partitionByBuffer(
    idList,
    buffer,
    floorOf,
    liveId,
  );

  /*-
   *  One read for everything the buffer could not answer. It runs before
   *  the loop below, so the loop only assembles: a throw here leaves the
   *  buffer exactly as it was.
   */
  const fetched =
    toFetch.length > 0
      ? await scanChainNftEvents(toFetch, {
          mintBlocks,
          sharedFloor: fromBlock,
        })
      : new Map();

  const allNftEvents = new Map();
  for (const tid of idList) {
    /*-
     *  `eventsFor` throws for an id the batch was not asked about, so an
     *  id missing here is a loud sequencing error rather than an NFT
     *  quietly reported as having no history.
     */
    const ev = reusedEv.has(tid) ? reusedEv.get(tid) : eventsFor(fetched, tid);
    allNftEvents.set(tid, ev);
    /*-
     *  Stored only after the read resolved, so a failed batch leaves the
     *  buffer untouched and the next attempt fetches again.
     *
     *  The live NFT is never stored, not merely never reused. It retires
     *  at the next rebalance, and from that moment it is no longer the
     *  live id and the entry looks reusable — but it was read while the
     *  NFT was still open, so it predates the drain that retired it.
     *  Reusing it would drop that NFT's closing Collect and
     *  DecreaseLiquidity and understate its lifetime fees. Only inert
     *  NFTs belong here.
     */
    if (buffer !== null && tid !== liveId)
      buffer.set(tid, { from: floorOf.get(tid), ev });
  }
  const reused = reusedEv.size;
  /*-
   *  One line after the fact, not one per NFT: on a long chain the
   *  per-NFT form would bury the scan's own progress output.
   *
   *  Silent when nothing was reused, so its presence means the resume
   *  actually did something. The batched read logs its progress per
   *  event type across the whole id list, not per NFT, so nothing else
   *  in the log says which NFTs were skipped — this line is the only
   *  record that the buffer answered any of them.
   */
  if (reused > 0)
    log.info(
      "[bot] Lifetime scan resumed: %d of %d NFT read(s) taken from the buffer, %d re-fetched",
      reused,
      allNftEvents.size,
      allNftEvents.size - reused,
    );
  return allNftEvents;
}

module.exports = { collectTokenIds, fetchAllNftEvents, partitionByBuffer };
