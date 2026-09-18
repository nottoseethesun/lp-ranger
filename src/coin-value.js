/**
 * @file src/coin-value.js
 * @module coin-value
 * @description
 *   Values a token pair at a pair of prices.
 *
 *   The app persists coins, never dollar totals: a saved dollar figure is
 *   true only at the price that computed it, so it drifts further from
 *   reality the longer a position runs.  Every figure showing a current
 *   total therefore prices its coins where it is displayed, and this is
 *   the one place that multiplication lives.
 *
 *   The historical figures are the deliberate exception and do not come
 *   through here: Total Lifetime Deposit values each deposit at its own
 *   block, the HODL Baseline's Entry Value stands at the NFT's mint, and
 *   the Historical P&L table's closed epochs keep the dollars they closed
 *   at.
 *
 *   A leaf module — no requires — so both the bot tier and the view tier
 *   can import it without pulling a dependency chain behind it.
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

module.exports = { coinsToUsd, nftCoinsToUsd };
