/**
 * @file src/bot/il-calculator.js
 * @module ilCalculator
 * @description
 * Standalone impermanent loss / gain calculator for Uniswap v3 positions.
 *
 * Provides two approaches:
 *  (a) **Price-ratio IL multiplier** — the classic v2 formula using the pool
 *      price ratio (currentPrice / entryPrice).  Returns a multiplier in
 *      [−1, 0] where 0 = no IL, −1 = total loss.
 *  (b) **HODL-comparison IL** — compares the current LP value, with any
 *      wallet residual the caller credits to it, against what holding the
 *      deposited tokens would be worth at current prices.
 *      `IL = (lpValue + residualValueUsd) − hodlValue`.  Negative = loss vs
 *      holding.
 *
 * The HODL comparison uses **only current prices** for valuation.  The
 * caller supplies the deposited token amounts, so no historical USD
 * prices are needed: for the Current IL/G, the coins the NFT was minted
 * with (from its mint's IncreaseLiquidity event) and the wallet's coins
 * its compounds took in since; for the Lifetime IL/G, the deposits of the
 * whole rebalance chain.
 *
 * @example
 * const { calcIlMultiplier, computeHodlIL } = require('./il-calculator');
 *
 * // Price-ratio approach
 * const mult = calcIlMultiplier(currentPoolPrice / entryPoolPrice);
 * const ilUsd = entryValue * mult;
 *
 * // HODL-comparison approach (actual deposited amounts)
 * const il = computeHodlIL({
 *   lpValue: 233,
 *   hodlAmount0: 73437.5,   // actual token0 deposited (human-readable)
 *   hodlAmount1: 195833.3,  // actual token1 deposited (human-readable)
 *   currentPrice0: 0.0016,
 *   currentPrice1: 0.0006,
 * });
 */

"use strict";

/**
 * Calculate the impermanent loss multiplier using the v2 price-ratio formula.
 * Works for any constant-product AMM.
 *
 * @param {number} priceRatio  currentPrice / entryPrice (pool price ratio).
 * @returns {number} IL multiplier in [−1, 0].  0 = no IL, −1 = total loss.
 */
function calcIlMultiplier(priceRatio) {
  if (priceRatio <= 0) return 0;
  return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
}

/**
 * Estimate current position value using the v3 IL approximation.
 * Applies a sensitivity factor to the v2 IL multiplier.
 *
 * @param {number} entryValue  USD value at entry.
 * @param {number} priceRatio  currentPrice / entryPrice.
 * @param {number} [ilFactor=0.38]  Sensitivity factor (0–1).
 * @returns {number} Estimated current value.
 */
function estimateLiveValue(entryValue, priceRatio, ilFactor = 0.38) {
  const ilMult = calcIlMultiplier(priceRatio);
  return entryValue * (1 + ilMult * ilFactor);
}

/**
 * Compute IL via HODL comparison using actual deposited token amounts.
 *
 * Compares the current LP value against what holding the originally deposited
 * tokens would be worth at current prices.  Uses only current prices — no
 * historical USD prices needed.
 *
 *   hodlValue = hodlAmount0 × currentPrice0 + hodlAmount1 × currentPrice1
 *   IL = (lpValue + residualValueUsd) − hodlValue
 *
 * Negative = loss vs holding, positive = gain vs holding.
 *
 * `residualValueUsd` is the current pool-scoped wallet residual in USD
 * (the "Wallet Residual (Pool)" figure surfaced in the dashboard's
 * Lifetime panel): the position's part of the wallet's balance of its
 * pool's two coins (src/bot/wallet-coin-share.js), such as a rebalance's
 * leftovers or a deposit still waiting, which the next rebalance mints
 * into the position.  Crediting it to the LP side counts the coins the
 * position has in the wallet, which matters on low-liquidity pairs whose
 * rebalance swaps leave material residuals, and little on high-liquidity
 * pairs whose swaps absorb everything. The Lifetime IL/G passes it; the
 * Current IL/G passes none, and the Impermanent Loss Guard reads the
 * Current IL/G, since they compare only the coins the NFT was minted with
 * and those put into it since (src/bot/bot-pnl-il.js).
 *
 * Per the user's "simple a vs b" mandate, the initial-mint residual is
 * NOT subtracted here.  Accepted edge case: the coins the first mint left
 * in the wallet are never counted as put in, so the Lifetime IL/G shows
 * about +$X, their value at today's prices: first as Wallet Residual
 * credit, and, once a rebalance mints them into the position, inside its
 * LP value.  The dashboard surfaces the initial residual as a separate
 * Lifetime panel line item so users can see it.
 *
 * @param {object} opts
 * @param {number} opts.lpValue        Current LP position value (USD).
 * @param {number} opts.hodlAmount0    Token0 amount originally deposited (human-readable).
 * @param {number} opts.hodlAmount1    Token1 amount originally deposited (human-readable).
 * @param {number} opts.currentPrice0  Token0 USD price now.
 * @param {number} opts.currentPrice1  Token1 USD price now.
 * @param {number} [opts.residualValueUsd=0]  Current pool-scoped wallet residual (USD).
 * @returns {number|null} IL in USD, or null if amounts are unavailable.
 */
function computeHodlIL({
  lpValue,
  hodlAmount0,
  hodlAmount1,
  currentPrice0,
  currentPrice1,
  residualValueUsd = 0,
}) {
  if (
    hodlAmount0 === null ||
    hodlAmount0 === undefined ||
    hodlAmount1 === null ||
    hodlAmount1 === undefined
  )
    return null;
  if (currentPrice0 <= 0 && currentPrice1 <= 0) return null;
  const hodlValue = hodlValueUsd({
    hodlAmount0,
    hodlAmount1,
    currentPrice0,
    currentPrice1,
  });
  return lpValue + (residualValueUsd || 0) - hodlValue;
}

/**
 * What holding the deposited coins is worth at the given prices: the
 * HODL side of `computeHodlIL`, on its own for a caller that needs the
 * amount IL is measured against, such as the Impermanent Loss Guard's
 * floor (src/bot/il-guard.js).
 *
 * @param {object} opts
 * @param {number} opts.hodlAmount0    Token0 amount originally deposited.
 * @param {number} opts.hodlAmount1    Token1 amount originally deposited.
 * @param {number} opts.currentPrice0  Token0 USD price now.
 * @param {number} opts.currentPrice1  Token1 USD price now.
 * @returns {number} USD.
 */
function hodlValueUsd({
  hodlAmount0,
  hodlAmount1,
  currentPrice0,
  currentPrice1,
}) {
  return hodlAmount0 * currentPrice0 + hodlAmount1 * currentPrice1;
}

module.exports = {
  calcIlMultiplier,
  estimateLiveValue,
  computeHodlIL,
  hodlValueUsd,
};
