/**
 * @file range-math.js
 * @module rangeMath
 * @description
 * Uniswap v3 / 9mm v3 tick and price math utilities.
 *
 * Uniswap v3 represents prices as square-root-price-X96 values (sqrtPriceX96)
 * and discretises the price space into integer "ticks" where each tick
 * corresponds to a 0.01% price move (tick spacing varies by fee tier).
 *
 * This module provides:
 *  - Conversion between sqrtPriceX96 ↔ human price
 *  - Conversion between price ↔ tick
 *  - Tick rounding to valid spacings
 *  - Range width calculation (new lower/upper given current price ± pct)
 *  - Token composition ratio within a range
 *
 * All math follows the Uniswap v3 white-paper formulas.
 *
 * @see {@link https://uniswap.org/whitepaper-v3.pdf}
 */

'use strict';

/** 2^96 — the fixed-point denominator used by Uniswap v3. */
const Q96 = BigInt('0x1000000000000000000000000');

/** V3 tick bounds (int24 range). */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

/** Tick spacing per fee tier. */
const TICK_SPACINGS = {
  100:   1,
  500:   10,
  2500:  50,
  3000:  60,
  10000: 200,
};

/**
 * Convert a sqrtPriceX96 value (as BigInt or string) to a human-readable
 * floating-point price.
 * price = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 − decimals1)
 *
 * @param {bigint|string} sqrtPriceX96
 * @param {number}        decimals0    Decimals of token0.
 * @param {number}        decimals1    Decimals of token1.
 * @returns {number}
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const sq  = BigInt(sqrtPriceX96);
  // Use scaled BigInt division to avoid Number overflow for large values.
  // We shift by 2^96 (not 2^192 all at once) to keep intermediate values
  // within a range where the final division produces a safe Number.
  // raw = (sq / Q96)^2, but we compute it as (sq^2 * SCALE) / Q96^2 / SCALE
  // to preserve precision.
  const SCALE = 10n ** 18n;
  const scaledRaw = (sq * sq * SCALE) / (Q96 * Q96);
  const raw = Number(scaledRaw) / Number(SCALE);
  return raw * Math.pow(10, decimals0 - decimals1);
}

/**
 * Convert a human-readable price to the nearest Uniswap v3 tick.
 * tick = floor( log(price × 10^(decimals1−decimals0)) / log(1.0001) )
 *
 * @param {number} price
 * @param {number} decimals0
 * @param {number} decimals1
 * @returns {number}
 */
function priceToTick(price, decimals0, decimals1) {
  if (price <= 0) throw new Error('priceToTick: price must be > 0');
  const adjusted = price * Math.pow(10, decimals1 - decimals0);
  const tick = Math.floor(Math.log(adjusted) / Math.log(1.0001));
  if (!Number.isFinite(tick)) {
    throw new Error(`priceToTick: result is not finite (price=${price}, d0=${decimals0}, d1=${decimals1})`);
  }
  return tick;
}

/**
 * Convert a tick to the corresponding human-readable price.
 * price = 1.0001^tick × 10^(decimals0−decimals1)
 *
 * @param {number} tick
 * @param {number} decimals0
 * @param {number} decimals1
 * @returns {number}
 */
function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * Round a raw tick to the nearest valid (usable) tick for a given fee tier.
 * @param {number} tick
 * @param {number} feeTier  e.g. 500, 3000, 10000
 * @returns {number}
 */
function nearestUsableTick(tick, feeTier) {
  const spacing = TICK_SPACINGS[feeTier] ?? 60;
  return (Math.round(tick / spacing) * spacing) || 0; // coerce -0 → 0
}

/**
 * Compute new lower and upper ticks for a rebalance centered on currentPrice
 * with a ±widthPct range.
 *
 * @param {number} currentPrice   Current pool price (human units).
 * @param {number} widthPct       Half-width percentage (e.g. 20 means ±20%).
 * @param {number} feeTier        Pool fee tier (500 | 3000 | 10000).
 * @param {number} decimals0      Token0 decimals.
 * @param {number} decimals1      Token1 decimals.
 * @returns {{ lowerTick: number, upperTick: number, lowerPrice: number, upperPrice: number }}
 */
function computeNewRange(currentPrice, widthPct, feeTier, decimals0, decimals1) {
  const factor     = widthPct / 100;
  // Clamp lowerPrice to a tiny positive value to avoid log(0)
  const lowerPrice = Math.max(currentPrice * (1 - factor), Number.EPSILON);
  const upperPrice = currentPrice * (1 + factor);

  let lowerTick = nearestUsableTick(priceToTick(lowerPrice, decimals0, decimals1), feeTier);
  let upperTick = nearestUsableTick(priceToTick(upperPrice, decimals0, decimals1), feeTier);
  const spacing  = TICK_SPACINGS[feeTier] ?? 60;

  // Clamp to V3 int24 bounds
  if (lowerTick < MIN_TICK) lowerTick = nearestUsableTick(MIN_TICK, feeTier);
  if (upperTick > MAX_TICK) upperTick = nearestUsableTick(MAX_TICK, feeTier);

  // Guarantee lower < upper and neither equals the current tick
  if (lowerTick >= upperTick) upperTick = lowerTick + spacing * 2;
  if (upperTick > MAX_TICK) upperTick = nearestUsableTick(MAX_TICK, feeTier);

  // ── Postcondition: ticks must be valid V3 values ─────────────────────────
  if (lowerTick < MIN_TICK || upperTick > MAX_TICK || lowerTick >= upperTick) {
    throw new Error(
      `computeNewRange: invalid ticks [${lowerTick}, ${upperTick}] `
      + `(bounds: [${MIN_TICK}, ${MAX_TICK}])`,
    );
  }

  // Return tick-derived prices so callers get the actual range boundaries
  return {
    lowerTick,
    upperTick,
    lowerPrice: tickToPrice(lowerTick, decimals0, decimals1),
    upperPrice: tickToPrice(upperTick, decimals0, decimals1),
  };
}

/**
 * Compute the token0 value fraction of a v3 position using the Uniswap v3
 * sqrt-price formula.
 *
 * In a V3 concentrated liquidity position:
 *   amount0 ∝ 1/sqrt(P) − 1/sqrt(Pu)
 *   amount1 ∝ sqrt(P) − sqrt(Pl)
 * Value fraction of token0 = (amount0 × P) / (amount0 × P + amount1).
 *
 * Returns a value in [0, 1] representing the fraction of position value that
 * is token0 (1 = fully token0, 0 = fully token1).
 *
 * @param {number} currentPrice
 * @param {number} lowerPrice
 * @param {number} upperPrice
 * @returns {number}
 */
function compositionRatio(currentPrice, lowerPrice, upperPrice) {
  if (currentPrice <= lowerPrice) return 1;
  if (currentPrice >= upperPrice) return 0;
  const sqrtP  = Math.sqrt(currentPrice);
  const sqrtPl = Math.sqrt(lowerPrice);
  const sqrtPu = Math.sqrt(upperPrice);
  // amount0 proportional = 1/sqrtP - 1/sqrtPu
  const a0 = (1 / sqrtP) - (1 / sqrtPu);
  // amount1 proportional = sqrtP - sqrtPl
  const a1 = sqrtP - sqrtPl;
  // value0 = a0 * currentPrice, value1 = a1
  const v0 = a0 * currentPrice;
  const total = v0 + a1;
  if (total <= 0) return 0.5;
  return Math.max(0, Math.min(1, v0 / total));
}

/**
 * Check whether a price is within a [lower, upper] range (inclusive).
 * @param {number} price
 * @param {number} lower
 * @param {number} upper
 * @returns {boolean}
 */
function isInRange(price, lower, upper) {
  return price >= lower && price <= upper;
}

/**
 * Check whether a price is within a buffer distance of either range edge.
 * Used by the "near edge" trigger.
 * @param {number} price
 * @param {number} lower
 * @param {number} upper
 * @param {number} edgePct  Percentage of the range width to use as buffer (0–49).
 * @returns {boolean}
 */
function isNearEdge(price, lower, upper, edgePct) {
  const buffer = (upper - lower) * (edgePct / 100);
  return price < lower + buffer || price > upper - buffer;
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  sqrtPriceX96ToPrice,
  priceToTick,
  tickToPrice,
  nearestUsableTick,
  computeNewRange,
  compositionRatio,
  isInRange,
  isNearEdge,
  TICK_SPACINGS,
  MIN_TICK,
  MAX_TICK,
};
