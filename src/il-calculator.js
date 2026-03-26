/**
 * @file src/il-calculator.js
 * @module ilCalculator
 * @description
 * Standalone impermanent loss / gain calculator for Uniswap v3 positions.
 *
 * Provides two approaches:
 *  (a) **Price-ratio IL multiplier** — the classic v2 formula using the pool
 *      price ratio (currentPrice / entryPrice).  Returns a multiplier in
 *      [−1, 0] where 0 = no IL, −1 = total loss.
 *  (b) **HODL-comparison IL** — compares the current LP value against what
 *      holding the original deposited tokens would be worth at current prices.
 *      `IL = lpValue − hodlValue`.  Negative = loss vs holding.
 *
 * The HODL comparison uses **only current prices** for valuation.  The original
 * deposited token amounts (from the IncreaseLiquidity event) determine the
 * HODL portfolio — no historical USD prices are needed.
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

'use strict';

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
 *   IL = lpValue − hodlValue
 *
 * Negative = loss vs holding, positive = gain vs holding.
 *
 * @param {object} opts
 * @param {number} opts.lpValue        Current LP position value (USD).
 * @param {number} opts.hodlAmount0    Token0 amount originally deposited (human-readable).
 * @param {number} opts.hodlAmount1    Token1 amount originally deposited (human-readable).
 * @param {number} opts.currentPrice0  Token0 USD price now.
 * @param {number} opts.currentPrice1  Token1 USD price now.
 * @returns {number|null} IL in USD, or null if amounts are unavailable.
 */
function computeHodlIL({ lpValue, hodlAmount0, hodlAmount1, currentPrice0, currentPrice1 }) {
  if (hodlAmount0 === null || hodlAmount0 === undefined || hodlAmount1 === null || hodlAmount1 === undefined) return null;
  if (currentPrice0 <= 0 && currentPrice1 <= 0) return null;
  const hodlValue = hodlAmount0 * currentPrice0 + hodlAmount1 * currentPrice1;
  return lpValue - hodlValue;
}

module.exports = { calcIlMultiplier, estimateLiveValue, computeHodlIL };
