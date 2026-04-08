/**
 * @file src/lifetime-hodl.js
 * @description Compute accumulated lifetime HODL amounts across a rebalance
 * chain.  Classifies each IncreaseLiquidity event as original-mint,
 * rebalance-mint, compound, or external-deposit, and accumulates only
 * genuine external deposits.
 *
 * Receives pre-fetched NFT events (from scanNftEvents) — zero RPC calls.
 */

"use strict";

const { _filterRebalances } = require("./compounder");

/**
 * Build an ordered list of tokenIds from rebalance events (oldest → newest).
 * @param {string|number} currentTokenId
 * @param {object[]} rebalanceEvents  Array of { oldTokenId, newTokenId }.
 * @returns {string[]} Ordered tokenIds.
 */
function _buildChainOrder(currentTokenId, rebalanceEvents) {
  const ids = new Set([String(currentTokenId)]);
  for (const ev of rebalanceEvents || []) {
    if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
    if (ev.newTokenId) ids.add(String(ev.newTokenId));
  }
  // Sort by first appearance in rebalance chain (oldest first).
  // Rebalance events are chronological: ev[0].old is the oldest NFT.
  const ordered = [];
  const remaining = new Set(ids);
  for (const ev of rebalanceEvents || []) {
    const old = String(ev.oldTokenId);
    if (remaining.has(old)) {
      ordered.push(old);
      remaining.delete(old);
    }
  }
  // Whatever is left (current tokenId, or single-NFT positions)
  for (const id of remaining) ordered.push(id);
  return ordered;
}

/**
 * Compute lifetime HODL amounts from pre-fetched NFT events.
 *
 * Classification per IncreaseLiquidity event:
 * - 1st IL on first NFT  → original mint  → full amounts
 * - 1st IL on Nth NFT    → rebalance mint → max(0, IL − prev NFT last Collect)
 * - Subsequent IL that is a compound (within fee cap) → 0
 * - Subsequent IL that is an external deposit → full amounts
 *
 * @param {Map<string, {ilEvents, collectEvents, dlEvents}>} allNftEvents
 * @param {object} opts
 * @param {object[]} opts.rebalanceEvents
 * @param {object}   opts.position  { tokenId, decimals0, decimals1 }
 * @returns {{ amount0: number, amount1: number }}
 */
/**
 * Classify subsequent ILs on one NFT as compound or external deposit.
 * Returns the accumulated external deposit amounts (raw BigInt).
 */
function _classifySubsequentILs(ilEvents, collectEvents, dlEvents) {
  if (ilEvents.length <= 1) return { ext0: 0n, ext1: 0n };
  const nonRebalance = _filterRebalances(ilEvents.slice(1), dlEvents);
  // Fee cap = total Collected − total DecreasedLiquidity = net fees only.
  // Collects include drain amounts from rebalances, which are NOT fees.
  let totCol0 = 0n,
    totCol1 = 0n,
    totDl0 = 0n,
    totDl1 = 0n;
  for (const e of collectEvents) {
    totCol0 += e.amount0 ?? 0n;
    totCol1 += e.amount1 ?? 0n;
  }
  for (const e of dlEvents) {
    totDl0 += e.amount0 ?? 0n;
    totDl1 += e.amount1 ?? 0n;
  }
  const feeCap0 = totCol0 > totDl0 ? totCol0 - totDl0 : 0n;
  const feeCap1 = totCol1 > totDl1 ? totCol1 - totDl1 : 0n;
  let compSum0 = 0n,
    compSum1 = 0n,
    ext0 = 0n,
    ext1 = 0n;
  for (const il of nonRebalance) {
    const w0 = compSum0 + il.amount0,
      w1 = compSum1 + il.amount1;
    if (w0 <= feeCap0 && w1 <= feeCap1) {
      compSum0 = w0;
      compSum1 = w1;
    } else {
      ext0 += il.amount0;
      ext1 += il.amount1;
    }
  }
  return { ext0, ext1 };
}

function computeLifetimeHodl(allNftEvents, opts) {
  const { rebalanceEvents, position } = opts;
  const ordered = _buildChainOrder(position.tokenId, rebalanceEvents);
  const d0 = position.decimals0 ?? 18;
  const d1 = position.decimals1 ?? 18;
  let totalRaw0 = 0n,
    totalRaw1 = 0n;

  for (let i = 0; i < ordered.length; i++) {
    const tid = ordered[i];
    const events = allNftEvents.get(tid);
    if (!events || events.ilEvents.length === 0) {
      console.log("[hodl] #%s (idx=%d): no IL events, skip", tid, i);
      continue;
    }
    const { ilEvents, collectEvents, dlEvents } = events;
    const mintIl = ilEvents[0];
    if (i === 0) {
      // Original mint: full amounts are the first external deposit
      console.log(
        "[hodl] #%s FIRST: mint0=%s mint1=%s",
        tid,
        String(mintIl.amount0),
        String(mintIl.amount1),
      );
      totalRaw0 += mintIl.amount0;
      totalRaw1 += mintIl.amount1;
    }
    // Rebalance mints (i > 0) contribute 0 — the mint just re-deposits
    // what was drained with a different token ratio from the swap.
    const { ext0, ext1 } = _classifySubsequentILs(
      ilEvents,
      collectEvents,
      dlEvents,
    );
    if (ext0 > 0n || ext1 > 0n)
      console.log(
        "[hodl] #%s external: ext0=%s ext1=%s",
        tid,
        String(ext0),
        String(ext1),
      );
    totalRaw0 += ext0;
    totalRaw1 += ext1;
  }

  return {
    amount0: Number(totalRaw0) / 10 ** d0,
    amount1: Number(totalRaw1) / 10 ** d1,
  };
}

module.exports = { computeLifetimeHodl, _buildChainOrder };
