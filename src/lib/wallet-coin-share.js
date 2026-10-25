/**
 * @file src/lib/wallet-coin-share.js
 * @module wallet-coin-share
 * @description
 * The part of the wallet's balance of a coin that a running managed
 * position's Wallet Residual (Pool) line counts as its own. The pools of
 * two or more running positions can contain the same coin, as two pools
 * that both contain WPLS do. The wallet's balance of such a coin is then
 * divided between those positions, so that it is counted once in all.
 *
 * A position's part is the amount of the coin its own NFT contains at the
 * current price, out of the amount the NFTs of all those positions
 * contain. Inside its range an NFT contains some of each of its pool's two
 * coins; outside its range it contains only one of them, and none of the
 * other. The asking position's amount is worked out at its own check. Each
 * other position's amount is the one it saved at the end of its last check
 * (`positionStats`, src/lib/bot-pnl-updater.js), so a position counts for
 * the others from the end of its first check until it stops; at both
 * moments src/lib/shared-coin-wake.js checks the others again at once.
 *
 * When none of those NFTs contains any of the coin, the wallet's balance of
 * it is divided by each position's value in dollars instead, each other
 * position's value as it published it at its last check. When none of them
 * has any value either, as when each one waits to mint after a rebalance
 * emptied it, the balance is divided evenly. A coin that no other running
 * position's pool contains is the asking position's alone, whatever its own
 * NFT contains.
 *
 * Pure. The poll asks `poolCoinShares` (`walletResiduals`,
 * src/lib/bot-pnl-updater.js), and src/lib/server-positions.js builds each
 * position's view of the others with `coinInOtherNfts`. The same share
 * divides a deposit of the coin that waits in the wallet
 * (src/lib/deposit-attribution.js).
 */

"use strict";

/** No other running position's pool contains the coin. */
const NO_OTHER_NFTS = Object.freeze({ amount: 0, value: 0, positions: 0 });

/**
 * Which of a position's saved coin amounts is the coin's, or null when its
 * pool does not contain the coin.
 * @param {object|null|undefined} activePosition  Its pool's two coins.
 * @param {string} coin  The coin's address, lower-cased.
 * @returns {"balance0"|"balance1"|null}
 */
function _savedAmountKey(activePosition, coin) {
  if (!activePosition) return null;
  if (activePosition.token0?.toLowerCase() === coin) return "balance0";
  if (activePosition.token1?.toLowerCase() === coin) return "balance1";
  return null;
}

/**
 * The other running managed positions whose pool contains a coin, as the
 * asking position's division counts them: the amount of the coin in their
 * NFTs as each saved it at the end of its last check, the sum of their
 * values in dollars as each published them then, and how many they are. A
 * position counts once a check of it has finished, and until it stops.
 *
 * @param {Iterable<object>} states  Every position's bot state.
 * @param {object} self  The asking position's bot state, which is left out.
 * @param {string} coin  The coin's address, in any case.
 * @returns {{amount: number, value: number, positions: number}}
 */
function coinInOtherNfts(states, self, coin) {
  const c = coin.toLowerCase();
  let amount = 0;
  let value = 0;
  let positions = 0;
  for (const s of states) {
    if (s === self || s.running !== true || !s.positionStats) continue;
    const key = _savedAmountKey(s.activePosition, c);
    if (key === null) continue;
    amount += Number(s.positionStats[key]) || 0;
    value += Number(s.pnlSnapshot?.currentValue) || 0;
    positions += 1;
  }
  return { amount, value, positions };
}

/**
 * The part of the wallet's balance of a coin that the asking position
 * counts as its own, from none to all of it.
 *
 * @param {number} own  The amount of the coin in its NFT at this check's
 *   price.
 * @param {number} ownValue  Its value in dollars at this check's prices.
 * @param {{amount: number, value: number, positions: number}} others
 *   From `coinInOtherNfts`.
 * @returns {number}
 */
function coinShare(own, ownValue, others) {
  const amount = own + others.amount;
  if (amount > 0) return own / amount;
  const value = ownValue + others.value;
  if (value > 0) return ownValue / value;
  return 1 / (1 + others.positions);
}

/**
 * The asking position's part of the wallet's balance of each of its pool's
 * two coins (`coinShare`).
 *
 * @param {Function|null|undefined} others  The asking position's view of
 *   the others (`coinInOtherNfts` for a coin, `_coinInOtherNfts` on its bot
 *   state); absent where it runs alone.
 * @param {{token0: string, token1: string}} position  Its pool's coins.
 * @param {{amount0: number, amount1: number}} own  The coins its NFT
 *   contains at this check's price.
 * @param {number} ownValue  Its value in dollars at this check's prices.
 * @returns {[number, number]}
 */
function poolCoinShares(others, position, own, ownValue) {
  const of = (coin) =>
    typeof others === "function" ? others(coin) : NO_OTHER_NFTS;
  return [
    coinShare(own.amount0, ownValue, of(position.token0)),
    coinShare(own.amount1, ownValue, of(position.token1)),
  ];
}

module.exports = {
  NO_OTHER_NFTS,
  coinInOtherNfts,
  coinShare,
  poolCoinShares,
};
