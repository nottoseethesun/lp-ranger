/**
 * @file src/bot-deposit.js
 * @description Compute total lifetime deposit USD from per-deposit
 * token amounts and historical prices.  Extracted from bot-pnl-updater.js
 * for line-count compliance.
 */

"use strict";

const { log } = require("./log");
const { fetchTokenPriceUsd } = require("./price-fetcher");

/** Fall back to current prices when historical sources return 0. */
async function _currentPriceFallback(p0, p1, opts, idx, block) {
  let price0 = p0,
    price1 = p1;
  if ((price0 > 0 && price1 > 0) || !opts?.token0)
    return { price0, price1, fallback: false };
  if (price0 <= 0) price0 = await fetchTokenPriceUsd(opts.token0);
  if (price1 <= 0) price1 = await fetchTokenPriceUsd(opts.token1);
  const used = price0 > 0 || price1 > 0;
  if (used)
    log.info("[deposit] #%d block=%d current-price fallback", idx, block);
  return { price0, price1, fallback: used };
}

/**
 * Value one deposit at the price for its own block.
 *
 * @param {object} dep  Deposit entry `{ raw0, raw1, block }`.
 * @param {number} d0   Token0 decimals.
 * @param {number} d1   Token1 decimals.
 * @param {Function} fetchPrices  async (blockNumber) => { price0, price1 }.
 * @param {object} [opts]  Token addresses, for the current-price fallback.
 * @param {number} idx  This deposit's position in the list, for the log.
 * @returns {Promise<{usd: number, fallback: boolean}|null>}  Null when the
 *   entry holds nothing worth pricing, or amounts that are not numbers.
 */
async function _priceOneDeposit(dep, d0, d1, fetchPrices, opts, idx) {
  const a0 = Number(BigInt(dep.raw0)) / 10 ** d0;
  const a1 = Number(BigInt(dep.raw1)) / 10 ** d1;
  /*- Undefined/NaN decimals make `10 ** d` NaN, which poisons the
   *  running total: $NaN reaches the dashboard as `NaN || 0` = $0 and
   *  pins ready=false, reporting nothing about why. The lifetime
   *  scan's heal step resolves decimals on-chain before this point,
   *  so reaching here with a bad one means that step did not cover
   *  the entry — skip and log it rather than let one deposit
   *  NaN-poison the whole total. */
  if (!Number.isFinite(a0) || !Number.isFinite(a1)) {
    log.warn(
      "[deposit] #%d block=%d skipped — non-finite amounts (a0=%s a1=%s, decimals d0=%s d1=%s)",
      idx,
      dep.block,
      a0,
      a1,
      d0,
      d1,
    );
    return null;
  }
  if (a0 <= 0 && a1 <= 0) return null;
  const hist = await fetchPrices(dep.block);
  const { price0, price1, fallback } = await _currentPriceFallback(
    hist.price0,
    hist.price1,
    opts,
    idx,
    dep.block,
  );
  const usd = a0 * price0 + a1 * price1;
  log.info(
    "[deposit] #%d block=%d a0=%s a1=%s p0=%s p1=%s → $%s",
    idx,
    dep.block,
    a0.toFixed(2),
    a1.toFixed(2),
    price0,
    price1,
    usd.toFixed(2),
  );
  return { usd, fallback };
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
 * @param {boolean} [opts.refresh]  Price every deposit again instead of
 *   reusing the figure memoized on it. Set by Re-scan Prices, whose whole
 *   purpose is to replace a figure a bad price produced.
 * @returns {Promise<number>} Total deposit USD.
 */
async function totalLifetimeDeposit(deposits, d0, d1, fetchPrices, opts) {
  if (!deposits || !deposits.length || !fetchPrices)
    return { total: 0, usedFallback: false };
  let total = 0;
  let usedFallback = false;
  const useMemo = opts?.refresh !== true;
  for (let i = 0; i < deposits.length; i++) {
    const dep = deposits[i];
    if (useMemo && dep.usd > 0) {
      log.info(
        "[deposit] #%d block=%d cached=$%s%s",
        i + 1,
        dep.block,
        dep.usd.toFixed(2),
        dep.fallback ? " (fallback)" : "",
      );
      if (dep.fallback) usedFallback = true;
      total += dep.usd;
      continue;
    }
    const priced = await _priceOneDeposit(
      dep,
      d0,
      d1,
      fetchPrices,
      opts,
      i + 1,
    );
    /*- Replace the figure only when a price came back. Zero means no
     *  source answered, and on a re-value the figure it would replace is
     *  better than nothing. On a first pass there is nothing to keep, so
     *  the entry stays unpriced and contributes nothing. */
    if (priced !== null && priced.usd > 0) {
      dep.usd = priced.usd;
      dep.fallback = priced.fallback;
    }
    if (dep.fallback) usedFallback = true;
    /*- Falsy-fallback on purpose: an entry no source could price has no
     *  figure at all, and it must contribute nothing rather than turn
     *  the running total into NaN. */
    total += dep.usd || 0;
  }
  log.info(
    "[deposit] Total lifetime deposit: $%s (%d entries%s)",
    total.toFixed(2),
    deposits.length,
    usedFallback ? ", fallback used" : "",
  );
  return { total, usedFallback };
}

module.exports = { totalLifetimeDeposit };
