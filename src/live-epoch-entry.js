/**
 * @file src/live-epoch-entry.js
 * @module live-epoch-entry
 * @description
 * Decides what a newly opened live P&L epoch should record as its entry
 * value, and opens it.
 *
 * The live epoch is the period the position is in right now. It is not
 * persisted — `_mergeAndPersist` in `epoch-reconstructor.js` writes only
 * the closed epochs — so every reconstruction discards it and the next
 * poll opens a fresh one. That is fine and deliberately cheap, PROVIDED
 * each re-open lands on the same answer.
 *
 * Stamping the entry as the position's value at open does not satisfy
 * that: the value moves with price, so the figure differs on every
 * restart. It surfaces in the Per-Day table's In/Out cell for the day
 * the current NFT was minted, computed as
 * `exit(previous NFT) − entry(current NFT)` — the position's price
 * decline since mint is reported there as though value had been left
 * in the wallet.
 *
 * The NFT's mint value does not move, and is already resolved on disk
 * as `hodlBaseline.entryValue` (from the `IncreaseLiquidity` on the mint
 * transaction, see `hodl-baseline.js`). Preferring it makes every
 * re-open identical, which is what lets the epoch stay unpersisted.
 */

"use strict";

const { log } = require("./log");

/**
 * Entry value to record for a live epoch about to be opened.
 *
 * Falls back to the position's present value only when no baseline has
 * resolved yet — a brand-new NFT whose mint receipt has not been read.
 * That case still drifts across restarts, but it corrects itself as
 * soon as the baseline lands.
 *
 * @param {object|null} botState  Live bot state; may carry `hodlBaseline`.
 * @param {number} currentValue   The position's value right now (USD).
 * @returns {number}
 */
function resolveLiveEntryValue(botState, currentValue) {
  const minted = botState?.hodlBaseline?.entryValue;
  if (typeof minted === "number" && minted > 0) return minted;
  return currentValue;
}

/**
 * Open the live epoch if the tracker has none.
 *
 * @param {object} pnlTracker    Tracker instance.
 * @param {object|null} botState Live bot state.
 * @param {object} opts
 * @param {number} opts.currentValue  Position value now (USD).
 * @param {number} opts.entryPrice    Pool price now.
 * @param {number} opts.lowerPrice    Range lower bound.
 * @param {number} opts.upperPrice    Range upper bound.
 * @param {number} opts.price0        Token0 USD price.
 * @param {number} opts.price1        Token1 USD price.
 * @returns {boolean}  Whether an epoch was opened.
 */
function ensureLiveEpoch(pnlTracker, botState, opts) {
  if (!pnlTracker || pnlTracker.getLiveEpoch()) return false;
  const ev = resolveLiveEntryValue(botState, opts.currentValue);
  /*- Never open at zero: the position may be mid-rebalance and drained.
   *  Wait until the mint restores liquidity. */
  if (!(ev > 0)) return false;
  pnlTracker.openEpoch({
    entryValue: ev,
    entryPrice: opts.entryPrice,
    lowerPrice: opts.lowerPrice,
    upperPrice: opts.upperPrice,
    token0UsdPrice: opts.price0,
    token1UsdPrice: opts.price1,
  });
  log.info("[pnl] Opened live epoch (entryValue=$%s)", ev.toFixed(2));
  return true;
}

module.exports = { resolveLiveEntryValue, ensureLiveEpoch };
