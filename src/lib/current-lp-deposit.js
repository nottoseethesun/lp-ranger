/**
 * @file src/lib/current-lp-deposit.js
 * @module current-lp-deposit
 * @description
 * What Initial Deposit for This LP, the Current panel's deposit, adds to
 * the coins an NFT was minted with: the coins its compounds took into it
 * from the wallet beyond their fees.
 *
 * A compound whose ratio swap runs deposits the wallet's whole balance of
 * the pool's two coins, so it can take in a deposit the owner sent, or
 * coins a rebalance left in the wallet (src/lib/compounded-coins.js). Those
 * coins were put into the NFT after its mint, and Current Value counts
 * them from then on. Initial Deposit for This LP counts them too, so the
 * Current panel's Net P&L does not read them as the NFT's gain, as Total
 * Lifetime Deposit counts each deposit for the Lifetime panel.
 *
 * Each compound's coins are valued at its own prices, as the mint's coins
 * are at the mint's: the prices the bot recorded with the compound, else
 * the prices at its block, through the price cache a rebuild of the
 * compound list prices it with (`compoundPricesFor`,
 * src/lib/compound-activity-figures.js), else today's prices, which flags
 * the figure as the mint's own missing price does. A compound whose record
 * does not tell its fees apart from the rest of its deposit adds nothing.
 *
 * The bot's Current panel figures (src/lib/bot-pnl-current-nft.js) and the
 * unmanaged view (src/lib/position-details-quick.js,
 * src/lib/position-details.js) both ask `addedByCompounds`, so both report
 * the same deposit for the same NFT.
 */

"use strict";

const { isPlainObject } = require("./plain-object");
const { walletCoinsOf } = require("./compounded-coins");
const { coinsToUsd } = require("./coin-value");

/** Whether a value is a price: a finite number above zero. */
function _isPrice(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * A compound's prices at its own time: those the bot recorded with it,
 * else those `pricesAt` finds at its block, else null.
 *
 * @param {object} compound  One entry of the compound list.
 * @param {Function|null|undefined} pricesAt  `(timestamp, blockNumber)`
 *   to its prices then, or null.
 * @returns {Promise<{price0: number, price1: number}|null>}
 */
async function _pricesThen(compound, pricesAt) {
  if (_isPrice(compound.price0) && _isPrice(compound.price1))
    return { price0: compound.price0, price1: compound.price1 };
  if (typeof pricesAt !== "function") return null;
  try {
    return await pricesAt(compound.timestamp ?? null, compound.blockNumber);
  } catch {
    return null;
  }
}

/**
 * One coin's price for a compound's addition: its price then, else
 * today's.
 *
 * @param {number} then  The price at the compound's time, if found.
 * @param {number} today  Today's price.
 * @returns {{price: number, fallback: boolean}}
 */
function _priceFor(then, today) {
  if (_isPrice(then)) return { price: then, fallback: false };
  return { price: _isPrice(today) ? today : 0, fallback: true };
}

/**
 * The dollars Initial Deposit for This LP adds to an NFT's minted coins:
 * the coins each of its compounds took in from the wallet beyond its fees,
 * each at that compound's prices.
 *
 * @param {object[]|undefined} history  The position's compound list.
 * @param {string|number} tokenId  The NFT.
 * @param {{decimals0: number, decimals1: number}} decimals
 * @param {Function|null|undefined} pricesAt  `(timestamp, blockNumber)` to
 *   the two prices at a compound's block (`compoundPricesFor`), or null.
 * @param {{price0: number, price1: number}} today  This check's prices.
 * @returns {Promise<{usd: number, fallback: boolean}>}  `fallback` when a
 *   compound's coins were valued at today's prices, its own being unknown.
 */
async function addedByCompounds(history, tokenId, decimals, pricesAt, today) {
  let usd = 0;
  let fallback = false;
  for (const c of Array.isArray(history) ? history : []) {
    if (!isPlainObject(c) || String(c.tokenId) !== String(tokenId)) continue;
    const coins = walletCoinsOf(c, decimals.decimals0, decimals.decimals1);
    if (coins === null || (coins.amount0 <= 0 && coins.amount1 <= 0)) continue;
    const then = await _pricesThen(c, pricesAt);
    const p0 = _priceFor(then?.price0, today.price0);
    const p1 = _priceFor(then?.price1, today.price1);
    if (
      (coins.amount0 > 0 && p0.fallback) ||
      (coins.amount1 > 0 && p1.fallback)
    )
      fallback = true;
    usd += coinsToUsd(coins, p0.price, p1.price);
  }
  return { usd, fallback };
}

module.exports = { addedByCompounds };
