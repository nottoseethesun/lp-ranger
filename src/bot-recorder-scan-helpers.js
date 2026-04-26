/**
 * @file src/bot-recorder-scan-helpers.js
 * @module bot-recorder-scan-helpers
 * @description
 * Small extracted helpers for `bot-recorder._scanLifetimePoolData` — kept in
 * a separate file so `bot-recorder.js` stays under the 500-line cap.
 */

"use strict";

const { scanNftEvents } = require("./compounder");

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
 * @param {Set<string>|string[]} ids
 * @param {number} fromBlock
 * @returns {Promise<{allNftEvents: Map<string, object>, maxBlock: number}>}
 */
async function fetchAllNftEvents(ids, fromBlock) {
  const allNftEvents = new Map();
  let maxBlock = fromBlock;
  for (const tid of ids) {
    const ev = await scanNftEvents(tid, { fromBlock });
    allNftEvents.set(tid, ev);
    for (const e of [...ev.ilEvents, ...ev.collectEvents, ...ev.dlEvents]) {
      if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
    }
  }
  return { allNftEvents, maxBlock };
}

module.exports = { collectTokenIds, fetchAllNftEvents };
