/**
 * @file util/diagnostic/verify-compound-usd-analysis.js
 * @description
 * Pure analysis and formatting for `verify-compound-usd.js`: no I/O, no
 * RPC, no console.  Extracted so the tool stays under the 500
 * non-comment-line cap and so every hypothesis test is unit-testable
 * without standing up a provider.
 *
 * The one project import is `_filterRebalances` from
 * `src/lib/compounder.js` — `classifyIl` deliberately delegates the
 * compound-vs-rebalance split to the production classifier so the
 * tool's labels always match the bot's own bookkeeping rather than
 * drifting from a second copy of the rule.
 *
 * Naming convention: the tool-specific analysis lives beside its tool
 * rather than in `_helpers.js`, which is reserved for helpers shared
 * across all of `util/diagnostic/`.
 */

"use strict";

const { _filterRebalances } = require("../../../src/lib/compounder");

/** How far either side of the on-chain decimals the shift search looks. */
const SHIFT_RANGE = 4;

/** Relative error at which a decimals-shift candidate counts as a match. */
const SHIFT_TOLERANCE = 0.05;

/**
 * USD value of a token pair, using the exact expression
 * `src/lib/compounder.js` `executeCompound` uses so a reproduction here is
 * a reproduction there.
 *
 * @param {bigint} raw0  Raw token0 amount (chain units).
 * @param {bigint} raw1  Raw token1 amount (chain units).
 * @param {number} d0    token0 decimals.
 * @param {number} d1    token1 decimals.
 * @param {number} p0    token0 USD price.
 * @param {number} p1    token1 USD price.
 * @returns {number} USD value.
 */
function usdOf(raw0, raw1, d0, d1, p0, p1) {
  return (
    (Number(raw0) / 10 ** d0) * (p0 || 0) +
    (Number(raw1) / 10 ** d1) * (p1 || 0)
  );
}

/**
 * Solve for the price inputs that would produce a reported USD figure.
 *
 * @param {number} reportedUsd  The figure to explain.
 * @param {object} ev  `{ raw0, raw1 }` raw amounts.
 * @param {object} tok `{ d0, d1, p0, p1 }` decimals and live prices.
 * @returns {{liveUsd: number, amount0: number, amount1: number,
 *   impliedP0: number|null, impliedP1: number|null,
 *   uniformScale: number|null}}
 */
function impliedPrices(reportedUsd, ev, tok) {
  const amount0 = Number(ev.raw0) / 10 ** tok.d0;
  const amount1 = Number(ev.raw1) / 10 ** tok.d1;
  const liveUsd = amount0 * (tok.p0 || 0) + amount1 * (tok.p1 || 0);
  return {
    liveUsd,
    amount0,
    amount1,
    impliedP0:
      amount0 > 0 ? (reportedUsd - amount1 * (tok.p1 || 0)) / amount0 : null,
    impliedP1:
      amount1 > 0 ? (reportedUsd - amount0 * (tok.p0 || 0)) / amount1 : null,
    uniformScale: liveUsd > 0 ? reportedUsd / liveUsd : null,
  };
}

/**
 * Find (decimals0, decimals1) pairs within ±SHIFT_RANGE of the
 * on-chain decimals that reproduce a reported USD figure to within
 * SHIFT_TOLERANCE.  A hit means the amounts were scaled by the wrong
 * power of ten rather than priced wrongly.
 *
 * @param {number} reportedUsd  The figure to explain.
 * @param {object} ev  `{ raw0, raw1 }` raw amounts.
 * @param {object} tok `{ d0, d1, p0, p1 }` decimals and prices.
 * @returns {Array<{d0: number, d1: number, usd: number, rel: number}>}
 *   Up to three candidates, closest first.
 */
function decimalsShiftCandidates(reportedUsd, ev, tok) {
  const out = [];
  if (!(reportedUsd > 0)) return out;
  for (let s0 = -SHIFT_RANGE; s0 <= SHIFT_RANGE; s0++) {
    for (let s1 = -SHIFT_RANGE; s1 <= SHIFT_RANGE; s1++) {
      if (s0 === 0 && s1 === 0) continue;
      const d0 = tok.d0 + s0;
      const d1 = tok.d1 + s1;
      if (d0 < 0 || d1 < 0) continue;
      const usd = usdOf(ev.raw0, ev.raw1, d0, d1, tok.p0, tok.p1);
      const rel = Math.abs(usd - reportedUsd) / reportedUsd;
      if (rel <= SHIFT_TOLERANCE) out.push({ d0, d1, usd, rel });
    }
  }
  out.sort((a, b) => a.rel - b.rel);
  return out.slice(0, 3);
}

/**
 * Compare a recorded row's stored amounts against the chain's.
 *
 * @param {object} row  A compoundHistory entry.
 * @param {object} ev   `{ raw0, raw1 }` from the matching chain event.
 * @returns {boolean} true when both stored amounts match the chain.
 */
function recordedAmountsMatch(row, ev) {
  const same = (stored, chain) => {
    if (stored === undefined || stored === null) return false;
    try {
      return BigInt(stored) === chain;
    } catch {
      return false;
    }
  };
  return (
    same(row.amount0Deposited, ev.raw0) && same(row.amount1Deposited, ev.raw1)
  );
}

/**
 * Split recorded rows into those belonging to the scanned NFT and those
 * recorded against a sibling NFT in the same rebalance chain.
 *
 * `compoundHistory` is stored per *position*, and a position's composite
 * key follows the live NFT across rebalances — so the array accumulates
 * rows for every tokenId the chain has ever had.  Without this split,
 * every sibling row reads as "no matching event", which looks like the
 * bot invented compounds that never happened.
 *
 * @param {object[]} history  compoundHistory rows.
 * @param {string} tokenId    The NFT actually scanned.
 * @returns {{own: object[], others: Map<string, number>}} Rows for this
 *   NFT, and a tokenId → row-count map for the rest.
 */
function splitHistoryByNft(history, tokenId) {
  const own = [];
  const others = new Map();
  for (const row of history) {
    /*- A row with no tokenId predates the field being recorded; treat it
     *  as this NFT's so it still gets compared by txHash. */
    const tid = row.tokenId === undefined ? null : String(row.tokenId);
    if (tid === null || tid === String(tokenId)) own.push(row);
    else others.set(tid, (others.get(tid) || 0) + 1);
  }
  return { own, others };
}

/**
 * Find the configured position whose `compoundHistory` holds rows for a
 * given tokenId.
 *
 * Needed because `--token-id` names one NFT while the rows live under
 * the position's composite key, which tracks the *current* NFT of the
 * rebalance chain.  Without this, the `--token-id` rerun the tool
 * itself prints for a sibling NFT would find no config and skip the
 * recorded-row comparison — the very comparison the operator wants.
 *
 * Prefers a key whose own tokenId segment matches, then falls back to
 * whichever position records rows for it.
 *
 * @param {object} positions  The config's `positions` map.
 * @param {string} tokenId
 * @returns {{key: string, config: object}|null}
 */
function findPositionForTokenId(positions, tokenId) {
  const want = String(tokenId);
  const entries = Object.entries(positions || {});
  const direct = entries.find((e) => e[0].split("-").pop() === want);
  if (direct) return { key: direct[0], config: direct[1] };
  const byHistory = entries.find((e) =>
    (e[1]?.compoundHistory || []).some((r) => String(r.tokenId) === want),
  );
  return byHistory ? { key: byHistory[0], config: byHistory[1] } : null;
}

/**
 * Label each IncreaseLiquidity event as mint / compound / rebalance.
 *
 * @param {object[]} ilEvents  Parsed IncreaseLiquidity events, ascending.
 * @param {object[]} dlEvents  Parsed DecreaseLiquidity events.
 * @param {boolean} mintInWindow  Whether the NFT's mint is in range.
 * @returns {Array<{ev: object, kind: 'mint'|'compound'|'rebalance'}>}
 */
function classifyIl(ilEvents, dlEvents, mintInWindow) {
  const candidates = mintInWindow ? ilEvents.slice(1) : ilEvents;
  const compounds = new Set(_filterRebalances(candidates, dlEvents));
  return ilEvents.map((ev, i) => {
    if (mintInWindow && i === 0) return { ev, kind: "mint" };
    return { ev, kind: compounds.has(ev) ? "compound" : "rebalance" };
  });
}

/** Format a USD amount with thousands separators. */
function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (
    "$" +
    v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** Format a price, with more precision below one cent. */
function fmtPrice(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return "$" + (v >= 0.01 ? v.toFixed(6) : v.toPrecision(6));
}

/** Format a ratio as `NN.NNx`, or `—` when it cannot be computed. */
function fmtRatio(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(2) + "x";
}

module.exports = {
  SHIFT_RANGE,
  SHIFT_TOLERANCE,
  usdOf,
  impliedPrices,
  decimalsShiftCandidates,
  recordedAmountsMatch,
  splitHistoryByNft,
  findPositionForTokenId,
  classifyIl,
  fmtUsd,
  fmtPrice,
  fmtRatio,
};
