/**
 * @file src/coin-value.js
 * @module coin-value
 * @description
 *   Values a token pair at a pair of prices, and compares pairs by value.
 *
 *   The app persists coins, never dollar totals: a saved dollar figure is
 *   true only at the price that computed it, so it drifts further from
 *   reality the longer a position runs.  Every figure showing a current
 *   total therefore prices its coins where it is displayed, and this is
 *   the one place that multiplication lives.
 *
 *   The Activity Log's Rebalance and Compound entries use it twice over.
 *   Each entry keeps its coins, and its figure is worked out from them at
 *   two sets of prices: once at the prices of the moment the entry is
 *   created, giving the Historical figure the entry stores, and again at
 *   today's prices, giving the Current figure the dashboard shows beside
 *   it. The comparisons at the end of this file are those figures, so
 *   both come from one formula.
 *
 *   Three historical totals do not come through here: Total Lifetime
 *   Deposit values each deposit at its own block, the HODL Baseline's
 *   Entry Value stands at the NFT's mint, and the Historical P&L table's
 *   closed epochs keep the dollars they closed at.
 *
 *   Deliberately dependency-free. The bot imports it, and so does the
 *   dashboard bundle, which works out the Current figures in the browser;
 *   a single `require` would break that build. Add no `require` to this
 *   file.
 */

"use strict";

/**
 * Value a coin pair.
 *
 * @param {{amount0: number, amount1: number}|null|undefined} amounts
 *   The coins.  A missing pair, or a missing side, counts as zero.
 * @param {number} price0  USD per whole token0.
 * @param {number} price1  USD per whole token1.
 * @returns {number}  USD value of the pair at those prices.
 */
function coinsToUsd(amounts, price0, price1) {
  /*- `??`, not `||`: the question is whether a figure is absent, and a
   *  coin count of zero is an answer rather than a gap. Both operators
   *  happen to yield the same number here, since the fallback is itself
   *  zero — written this way because the check should say what it
   *  means, not because the arithmetic depends on it. */
  const a0 = amounts?.amount0 ?? 0;
  const a1 = amounts?.amount1 ?? 0;
  return a0 * (price0 ?? 0) + a1 * (price1 ?? 0);
}

/**
 * Value one NFT's entry in a per-tokenId coins map.
 *
 * Used for the Current panel and for the current-NFT IL/G figure, both of
 * which ask what THIS NFT compounded rather than what the whole rebalance
 * chain did.
 *
 * @param {object|null|undefined} map  Coins keyed by tokenId, each
 *   `{amount0, amount1}`.  A tokenId with no entry counts as zero, which
 *   is the honest reading right after a rebalance mints a new NFT and
 *   before its scan lands.
 * @param {string|number} tokenId  The NFT to value.
 * @param {number} price0  USD per whole token0.
 * @param {number} price1  USD per whole token1.
 * @returns {number}  USD value of that NFT's compounded coins.
 */
function nftCoinsToUsd(map, tokenId, price0, price1) {
  if (map === undefined || map === null) return 0;
  return coinsToUsd(map[String(tokenId)], price0, price1);
}

/**
 * Whether `n` is a finite number above zero, as a usable price or a
 * total worth dividing by is.
 * @param {*} n  Any value.
 * @returns {boolean}
 */
function isPositiveNumber(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Whether `n` is a finite number of at least zero. */
function _isAmount(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Whether `c` is a coin pair: `{amount0, amount1}`, each a finite number
 * of coins of at least zero.
 * @param {*} c  Any value.
 * @returns {boolean}
 */
function isCoinPair(c) {
  return (
    c !== null &&
    typeof c === "object" &&
    _isAmount(c.amount0) &&
    _isAmount(c.amount1)
  );
}

/**
 * Whether `u` is a token amount in the token's smallest unit: a bigint,
 * a string of digits, or a whole number, none of them below zero.
 */
function _isUnits(u) {
  if (typeof u === "bigint") return u >= 0n;
  if (typeof u === "string") return /^[0-9]+$/.test(u);
  return typeof u === "number" && Number.isInteger(u) && u >= 0;
}

/** Whether `d` is an ERC-20 decimals value: a whole number, 0 to 255. */
function _isDecimals(d) {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 255;
}

/**
 * Turn a pair of token amounts into whole coins.
 *
 * The chain and the bot's own readings give amounts in each token's
 * smallest unit, while everything that is valued or stored for display
 * is in whole coins: a token with 18 decimals counts one coin as 10^18
 * units. This divides each side by its own scale. The result is a plain
 * number, exact enough for a valuation, though not for moving coins.
 *
 * @param {bigint|string|number} units0  Token0 amount, smallest unit.
 * @param {bigint|string|number} units1  Token1 amount, smallest unit.
 * @param {number} decimals0  Token0's decimals.
 * @param {number} decimals1  Token1's decimals.
 * @returns {{amount0: number, amount1: number}|null}  The coins, or null
 *   when an amount is not a whole amount of at least zero or a decimals
 *   value is not one a token can have.
 */
function coinsFromUnits(units0, units1, decimals0, decimals1) {
  if (!_isUnits(units0) || !_isUnits(units1)) return null;
  if (!_isDecimals(decimals0) || !_isDecimals(decimals1)) return null;
  return {
    amount0: Number(units0) / 10 ** decimals0,
    amount1: Number(units1) / 10 ** decimals1,
  };
}

/**
 * The impermanent loss or gain between two baskets of a pair, as a
 * percent of the second.
 *
 * A rebalance's Activity Log entry stores the pair's coins as they stood
 * before its swaps and after them. Valued at any one set of prices, the
 * difference between the two is what the swaps did: at the prices of the
 * rebalance itself, roughly their cost; at later prices, also how the
 * coins they bought have moved against the coins they sold. Divided by
 * the value after, it is that effect as a share of the position the
 * rebalance left. A negative result is a loss.
 *
 * @param {{amount0: number, amount1: number}} before  Coins before.
 * @param {{amount0: number, amount1: number}} after   Coins after.
 * @param {number} price0  USD per whole token0.
 * @param {number} price1  USD per whole token1.
 * @returns {number|null}  The percent, or null when a price is missing or
 *   not above zero (one side valued at nothing would make the comparison
 *   meaningless), a basket is malformed, or the basket after is worth
 *   nothing.
 */
function rebalanceIlPct(before, after, price0, price1) {
  if (!isPositiveNumber(price0) || !isPositiveNumber(price1)) return null;
  if (!isCoinPair(before) || !isCoinPair(after)) return null;
  const valueAfter = coinsToUsd(after, price0, price1);
  if (valueAfter <= 0) return null;
  const valueBefore = coinsToUsd(before, price0, price1);
  return ((valueAfter - valueBefore) / valueAfter) * 100;
}

/**
 * A coin pair's value as a percent of a dollar total.
 *
 * A compound's Activity Log entry stores the fee coins it collected, and
 * its Current figure is those coins at today's prices as a share of the
 * position's value today.
 *
 * @param {{amount0: number, amount1: number}} coins  The coins.
 * @param {number} price0  USD per whole token0.
 * @param {number} price1  USD per whole token1.
 * @param {number} totalUsd  The total to compare against, in USD.
 * @returns {number|null}  The percent, or null when a price is missing or
 *   not above zero, the coins are malformed, or the total is not a
 *   number above zero.
 */
function shareOfValuePct(coins, price0, price1, totalUsd) {
  if (!isPositiveNumber(price0) || !isPositiveNumber(price1)) return null;
  if (!isCoinPair(coins) || !isPositiveNumber(totalUsd)) return null;
  return (coinsToUsd(coins, price0, price1) / totalUsd) * 100;
}

module.exports = {
  coinsToUsd,
  nftCoinsToUsd,
  coinsFromUnits,
  rebalanceIlPct,
  shareOfValuePct,
  isPositiveNumber,
  isCoinPair,
};
