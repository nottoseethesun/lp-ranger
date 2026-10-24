"use strict";

/**
 * @file src/nft-move-rules.js
 * @module nft-move-rules
 * @description
 * Which of an NFT's events began a move. A move is a rebalance or a
 * compound, and each sends its transactions in a set order: a rebalance
 * drains the old NFT, swaps, and mints a new one; a compound collects an
 * NFT's fees, may swap, and deposits them back into the same NFT. The
 * position manager's events for an NFT (`IncreaseLiquidity`,
 * `DecreaseLiquidity` and `Collect`, each naming the NFT) are enough to
 * find the transaction a move began with, given the one it ended with.
 *
 * Two rules answer that, and two parts of the app need them. The bot
 * applies them to the NFT events its lifetime scan has already read, to
 * work out each Activity Log entry's figures; the bookkeeping report in
 * `util/bookkeeping` applies them to the logs it searches the chain for.
 * Keeping the rules here gives both one definition.
 *
 * - **A rebalance's drain** is the old NFT's latest `DecreaseLiquidity`
 *   at or before the new NFT's mint. LP Ranger drains an NFT whole, in
 *   one transaction that also collects, so its last `DecreaseLiquidity`
 *   is the drain, whether this rebalance sent it or an earlier attempt
 *   that failed after it did.
 * - **A compound's collect** is the event just before its deposit,
 *   provided that event is a `Collect` within one span of log blocks.
 *   When the event just before is another deposit, or there is none in
 *   the span, nothing was collected for this deposit: the coins came
 *   from the owner, not from fees.
 *
 * The module reads nothing itself. Each event is a plain object with
 * `blockNumber`, `txHash` and, when the caller knows it, `logIndex`, its
 * position within its block; the compound rule also needs each event's
 * `kind`, `"collect"` or `"deposit"`. The caller maps its own logs or
 * parsed events to that shape. Two events in one block are ordered by
 * `logIndex` when both carry it, and otherwise keep the order given.
 */

/**
 * Compare two events by where the chain put them: block first, then
 * position within the block when both events know it. Used to sort an
 * NFT's events, here and by the compound figures
 * (src/compound-activity-figures.js).
 * @param {{blockNumber: number, logIndex?: number}} a
 * @param {{blockNumber: number, logIndex?: number}} b
 * @returns {number}  Negative when `a` came first, positive when `b` did,
 *   zero when the two cannot be told apart.
 */
function chainOrder(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  if (typeof a.logIndex === "number" && typeof b.logIndex === "number")
    return a.logIndex - b.logIndex;
  return 0;
}

/**
 * Whether two hex strings, transaction hashes or addresses, are the same.
 * An endpoint writes a hash in lower case and an address may be
 * checksummed, while a caller may write either either way, so case is
 * ignored. Anything that is not a string matches nothing.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function sameHex(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

/**
 * The drain that began a rebalance: the old NFT's latest
 * `DecreaseLiquidity` at or before the block of the new NFT's mint.
 *
 * @param {Array<{blockNumber: number, logIndex?: number}>} decreases  The
 *   old NFT's `DecreaseLiquidity` events, in any order.
 * @param {number} mintBlock  The block of the new NFT's mint.
 * @returns {object|null}  That event, or null when the NFT has none at or
 *   before the mint.
 */
function drainBefore(decreases, mintBlock) {
  if (!Array.isArray(decreases)) return null;
  const before = decreases.filter((e) => e.blockNumber <= mintBlock);
  if (before.length === 0) return null;
  return [...before].sort(chainOrder).at(-1);
}

/**
 * Whether event `e` came before event `own` on the chain. Without
 * position-in-block for both, an event in the same block counts as
 * before it, as the order the caller gave is all there is to go on; a
 * caller that must not count `own` itself sets it aside by its
 * transaction first.
 * @param {{blockNumber: number, logIndex?: number}} e
 * @param {{blockNumber: number, logIndex?: number}} own
 * @returns {boolean}
 */
function isBefore(e, own) {
  if (e.blockNumber !== own.blockNumber) return e.blockNumber < own.blockNumber;
  if (typeof e.logIndex === "number" && typeof own.logIndex === "number")
    return e.logIndex < own.logIndex;
  return true;
}

/**
 * The collect that began a compound, or null when the deposit was coins
 * the owner added.
 *
 * Looks at the NFT's events in the span of log blocks that ends at the
 * deposit. The deposit itself is set aside, matched by its transaction.
 * Of the rest, the latest before the deposit decides: a `Collect` is the
 * compound's collect, and a deposit means another deposit came after any
 * collect, so this one collected nothing.
 *
 * @param {Array<{kind: string, blockNumber: number, txHash: string,
 *   logIndex?: number}>} events  The NFT's `Collect` events (`kind`
 *   `"collect"`) and `IncreaseLiquidity` events (`kind` `"deposit"`, the
 *   mint among them), in chain order where the caller cannot supply
 *   `logIndex`.
 * @param {{blockNumber: number, txHash: string, logIndex?: number}} deposit
 *   The deposit that ended the compound. Its `logIndex` is taken from
 *   the matching event in `events` when not given here.
 * @param {number} span  The span of log blocks to look back over.
 * @returns {object|null}  The collect event, or null.
 */
function collectBeforeDeposit(events, deposit, span) {
  const list = Array.isArray(events) ? events : [];
  const match = list.find((e) => sameHex(e.txHash, deposit.txHash));
  const own = { ...deposit, logIndex: deposit.logIndex ?? match?.logIndex };
  const floor = own.blockNumber - span + 1;
  const before = list.filter(
    (e) =>
      !sameHex(e.txHash, own.txHash) &&
      e.blockNumber >= floor &&
      isBefore(e, own),
  );
  if (before.length === 0) return null;
  const latest = [...before].sort(chainOrder).at(-1);
  return latest.kind === "collect" ? latest : null;
}

module.exports = {
  drainBefore,
  collectBeforeDeposit,
  chainOrder,
  sameHex,
  isBefore,
};
