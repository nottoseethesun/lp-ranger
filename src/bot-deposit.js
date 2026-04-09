/**
 * @file src/bot-deposit.js
 * @description Compute total lifetime deposit USD from per-deposit
 * token amounts and historical prices.  Extracted from bot-pnl-updater.js
 * for line-count compliance.
 */

"use strict";

const { fetchTokenPriceUsd } = require("./price-fetcher");

/** Fall back to current prices when historical sources return 0. */
async function _currentPriceFallback(p0, p1, opts, idx, block) {
  let price0 = p0,
    price1 = p1;
  if ((price0 > 0 && price1 > 0) || !opts?.token0) return { price0, price1 };
  if (price0 <= 0) price0 = await fetchTokenPriceUsd(opts.token0);
  if (price1 <= 0) price1 = await fetchTokenPriceUsd(opts.token1);
  if (price0 > 0 || price1 > 0)
    console.log("[deposit] #%d block=%d current-price fallback", idx, block);
  return { price0, price1 };
}

/**
 * Compute total lifetime deposit USD from per-deposit token amounts
 * and historical prices.  Each deposit entry has { raw0, raw1, block }
 * from the HODL scan.  Prices are fetched per-block for accuracy.
 * Falls back to current prices when historical sources return 0.
 *
 * @param {object[]} deposits  Array of { raw0: string, raw1: string, block: number }.
 * @param {number} d0  Token0 decimals.
 * @param {number} d1  Token1 decimals.
 * @param {Function} fetchPrices  async (blockNumber) => { price0, price1 }.
 * @param {object} [opts]  Optional token addresses for current-price fallback.
 * @param {string} [opts.token0]  Token0 contract address.
 * @param {string} [opts.token1]  Token1 contract address.
 * @returns {Promise<number>} Total deposit USD.
 */
async function totalLifetimeDeposit(deposits, d0, d1, fetchPrices, opts) {
  if (!deposits || !deposits.length || !fetchPrices) return 0;
  let total = 0;
  for (let i = 0; i < deposits.length; i++) {
    const dep = deposits[i];
    if (dep.usd > 0) {
      console.log(
        "[deposit] #%d block=%d cached=$%s",
        i + 1,
        dep.block,
        dep.usd.toFixed(2),
      );
      total += dep.usd;
      continue;
    }
    const a0 = Number(BigInt(dep.raw0)) / 10 ** d0;
    const a1 = Number(BigInt(dep.raw1)) / 10 ** d1;
    if (a0 <= 0 && a1 <= 0) continue;
    const hist = await fetchPrices(dep.block);
    const { price0, price1 } = await _currentPriceFallback(
      hist.price0,
      hist.price1,
      opts,
      i + 1,
      dep.block,
    );
    dep.usd = a0 * price0 + a1 * price1;
    console.log(
      "[deposit] #%d block=%d a0=%s a1=%s p0=%s p1=%s → $%s",
      i + 1,
      dep.block,
      a0.toFixed(2),
      a1.toFixed(2),
      price0,
      price1,
      dep.usd.toFixed(2),
    );
    total += dep.usd;
  }
  console.log(
    "[deposit] Total lifetime deposit: $%s (%d entries)",
    total.toFixed(2),
    deposits.length,
  );
  return total;
}

module.exports = { totalLifetimeDeposit };
