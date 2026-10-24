/**
 * @file src/lib/counted-deposits.js
 * @module counted-deposits
 * @description
 * What the deposit count's records add to a position's figures, in coins.
 *
 * The deposit count (src/lib/deposit-count.js) records each deposit the owner
 * makes to the wallet, one entry per transaction, in two places. What a
 * rebalance's or a compound's count finds goes into the pool's Lifetime
 * results (`lifetimeHodlAmounts` in the epoch cache): its coins are added
 * to the lifetime holding, and its entry, which names its transaction,
 * joins the deposit list that Total Lifetime Deposit is priced from. What
 * a poll finds between moves is held on the bot state instead
 * (`_depositOverlay`), until the next move's count reads the same blocks
 * again and records them in its place.
 *
 * The figures read those records through this module. The Lifetime
 * figures already hold the moves' counts, so they add only what polls
 * have found since (`pollDeposits`). A Rebalance entry's Activity Log
 * figures set aside the coins deposited since the old NFT's mint
 * (`countedCoinsAfter`, src/lib/rebalance-activity-figures.js). The Current
 * IL/G and the Impermanent Loss Guard count no deposit: they count no
 * coin in the wallet (src/lib/bot-pnl-il.js).
 *
 * Pure: no files, no chain, no logging, so the bot and the unmanaged
 * details view share it.
 */

"use strict";

const { coinsFromUnits } = require("./coin-value");
const { mintBlocksByTokenId } = require("./nft-mint-blocks");
const { isPlainObject } = require("./plain-object");

/**
 * Whether a deposit entry is an addition of liquidity another wallet
 * paid for: money put in that went straight into a position NFT, never
 * through the wallet. The Lifetime scan enters each at its own block,
 * naming its transaction (src/lib/lifetime-hodl.js).
 *
 * @param {*} d  A deposit entry.
 * @returns {boolean}
 */
function isAdditionEntry(d) {
  return isPlainObject(d) && d.kind === "external";
}

/**
 * Whether a deposit entry is one deposit to the wallet, naming its
 * transaction: one the deposit count recorded as it arrived, or one the
 * Lifetime scan entered for a deposit a mint took in
 * (src/lib/lifetime-hodl.js). The two are alike, so a scan that builds the
 * list again from the chain enters what the count recorded. Not an
 * addition another wallet paid for (`isAdditionEntry`), which names its
 * transaction too but never passed through the wallet; nor the first
 * mint's entry, nor a window an earlier version summed into one entry at
 * its mint's block, which name none.
 *
 * @param {*} d  A deposit entry.
 * @returns {boolean}
 */
function isCountedEntry(d) {
  return (
    isPlainObject(d) &&
    typeof d.txHash === "string" &&
    d.txHash !== "" &&
    !isAdditionEntry(d)
  );
}

/**
 * An entry's coins, or none when its amounts or the decimals are not
 * what an entry holds.
 */
function _coinsOf(d, d0, d1) {
  return coinsFromUnits(d.raw0, d.raw1, d0, d1) ?? { amount0: 0, amount1: 0 };
}

/** An entry's amount in the coin's smallest unit, or none when malformed. */
function _units(raw) {
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
}

/** The entries a poll's count holds, or none when there is no overlay. */
function _overlayEntries(overlay) {
  if (!isPlainObject(overlay) || !Array.isArray(overlay.entries)) return [];
  return overlay.entries.filter(isCountedEntry);
}

/**
 * The coins deposited to the wallet after a block, one entry per
 * transaction (`isCountedEntry`): those the Lifetime results hold, the
 * moves' counts and the Lifetime scan's own, and what polls have found
 * since.
 *
 * @param {object|null|undefined} lifetimeHodl  The pool's
 *   `lifetimeHodlAmounts`.
 * @param {object|null|undefined} overlay  The bot state's
 *   `_depositOverlay`, `{through, entries}`.
 * @param {number} afterBlock  Only deposits in later blocks count.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @param {number} [throughBlock]  Nor deposits in blocks after this one;
 *   no bound when left out.
 * @returns {{amount0: number, amount1: number}}
 */
function countedCoinsAfter(
  lifetimeHodl,
  overlay,
  afterBlock,
  d0,
  d1,
  throughBlock = Infinity,
) {
  const saved = isPlainObject(lifetimeHodl)
    ? (Array.isArray(lifetimeHodl.deposits)
        ? lifetimeHodl.deposits
        : []
      ).filter(isCountedEntry)
    : [];
  let amount0 = 0;
  let amount1 = 0;
  for (const d of [...saved, ..._overlayEntries(overlay)]) {
    if (!(d.block > afterBlock) || d.block > throughBlock) continue;
    const c = _coinsOf(d, d0, d1);
    amount0 += c.amount0;
    amount1 += c.amount1;
  }
  return { amount0, amount1 };
}

/**
 * What polls have counted that the Lifetime results do not hold yet: the
 * overlay's entries after the newest mint the results cover. One at or
 * below that mint is already in the Lifetime scan's count for the mint,
 * which took it in.
 *
 * @param {object|null|undefined} lifetimeHodl  The pool's
 *   `lifetimeHodlAmounts`.
 * @param {object|null|undefined} overlay  The bot state's
 *   `_depositOverlay`.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {{amount0: number, amount1: number, usd: number}}  `usd` is
 *   each deposit at its own block's price, as Total Lifetime Deposit
 *   values its entries.
 */
function pollDeposits(lifetimeHodl, overlay, d0, d1) {
  const covered = isPlainObject(lifetimeHodl) ? lifetimeHodl.lastBlock : 0;
  const after = typeof covered === "number" ? covered : 0;
  let amount0 = 0;
  let amount1 = 0;
  let usd = 0;
  for (const d of _overlayEntries(overlay)) {
    if (!(d.block > after)) continue;
    const c = _coinsOf(d, d0, d1);
    amount0 += c.amount0;
    amount1 += c.amount1;
    if (typeof d.usd === "number" && d.usd > 0) usd += d.usd;
  }
  return { amount0, amount1, usd };
}

/**
 * The coins a figure measures against, with the deposits made since
 * added. With none resolved yet there is nothing to add to, so the
 * figure stays unknown, as it was, rather than being measured against
 * the deposits alone.
 *
 * @param {{amount0?: number, amount1?: number}|null|undefined} held  The
 *   coins put in before: an NFT's minted coins, or the lifetime holding.
 * @param {{amount0: number, amount1: number}} deposits  The deposits
 *   since, from `countedCoinsAfter` or `pollDeposits`.
 * @returns {{amount0: number|undefined, amount1: number|undefined}}
 */
function plusDeposits(held, deposits) {
  const a0 = held?.amount0;
  const a1 = held?.amount1;
  if (!(a0 > 0 || a1 > 0)) return { amount0: a0, amount1: a1 };
  return {
    amount0: (a0 ?? 0) + deposits.amount0,
    amount1: (a1 ?? 0) + deposits.amount1,
  };
}

/**
 * The block an NFT was minted in, from the rebalance chain's events: a
 * rebalance's own record for the NFTs rebalances minted, else the chain's
 * first mint when this NFT is that one.
 *
 * @param {string|number} tokenId  The NFT.
 * @param {Array & {chainFirstTokenId?: string,
 *   chainFirstMintBlock?: number, firstMintTokenId?: string,
 *   firstMintBlockNumber?: number}} events  The chain's rebalance events.
 * @returns {number|null}  Null when the events do not say.
 */
function nftMintBlock(tokenId, events) {
  const tid = String(tokenId ?? "");
  if (tid === "") return null;
  const minted = mintBlocksByTokenId(events).get(tid);
  if (minted !== undefined) return minted;
  if (!Array.isArray(events)) return null;
  const firsts = [
    [events.chainFirstTokenId, events.chainFirstMintBlock],
    [events.firstMintTokenId, events.firstMintBlockNumber],
  ];
  for (const [id, block] of firsts)
    if (String(id ?? "") === tid && typeof block === "number" && block > 0)
      return block;
  return null;
}

/**
 * Lifetime results worked out by a scan, with the deposit count's records
 * that landed while it ran put back.
 *
 * A Lifetime scan reads the saved results when it starts and writes its
 * own when it ends, minutes later. A count saved in between saved entries
 * the scan never saw, and the scan's write would drop them. Their transactions
 * lie after the newest mint the scan read, so none of its windows counted
 * them, and keeping them counts each once.
 *
 * @param {object} hodl  The scan's results.
 * @param {object|null|undefined} latest  The saved results as they stand
 *   when the scan writes.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {object}  `hodl` when nothing landed meanwhile; otherwise a
 *   copy holding the later entries, their coins and their reach.
 */
function withLaterCounts(hodl, latest, d0, d1) {
  if (!isPlainObject(latest) || !Array.isArray(latest.deposits)) return hodl;
  const have = new Set(
    (hodl.deposits || [])
      .filter(isCountedEntry)
      .map((d) => d.txHash.toLowerCase()),
  );
  const later = latest.deposits.filter(
    (d) => isCountedEntry(d) && !have.has(d.txHash.toLowerCase()),
  );
  if (later.length === 0) return hodl;
  const reach = Math.max(
    typeof hodl.countedThrough === "number" ? hodl.countedThrough : 0,
    typeof latest.countedThrough === "number" ? latest.countedThrough : 0,
  );
  return { ...withDepositsAdded(hodl, later, d0, d1), countedThrough: reach };
}

/**
 * Lifetime results with deposits added: their coins to the lifetime
 * holding (`amount0`, `amount1`), their amounts to the fresh totals
 * (`raw0`, `raw1`), and their entries to the deposit list. A move's
 * count adds what it found this way (src/lib/deposit-count.js), and so does
 * a scan keeping a count that landed while it ran (`withLaterCounts`).
 *
 * @param {object} hodl  The pool's `lifetimeHodlAmounts`.
 * @param {object[]} entries  The deposits, `{raw0, raw1, block, ...}`.
 * @param {number} d0  Token0's decimals.
 * @param {number} d1  Token1's decimals.
 * @returns {object}  A copy; `hodl` is left as it was.
 */
function withDepositsAdded(hodl, entries, d0, d1) {
  let raw0 = _units(hodl.raw0);
  let raw1 = _units(hodl.raw1);
  let amount0 = typeof hodl.amount0 === "number" ? hodl.amount0 : 0;
  let amount1 = typeof hodl.amount1 === "number" ? hodl.amount1 : 0;
  for (const d of entries) {
    raw0 += _units(d.raw0);
    raw1 += _units(d.raw1);
    const c = _coinsOf(d, d0, d1);
    amount0 += c.amount0;
    amount1 += c.amount1;
  }
  return {
    ...hodl,
    amount0,
    amount1,
    raw0: String(raw0),
    raw1: String(raw1),
    deposits: [
      ...(Array.isArray(hodl.deposits) ? hodl.deposits : []),
      ...entries,
    ],
  };
}

module.exports = {
  isAdditionEntry,
  isCountedEntry,
  countedCoinsAfter,
  pollDeposits,
  plusDeposits,
  nftMintBlock,
  withDepositsAdded,
  withLaterCounts,
};
