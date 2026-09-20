/**
 * @file src/historical-token-price.js
 * @module historicalTokenPrice
 * @description
 * One token's USD price on a past day.
 *
 * `price-fetcher.js` already answers this for a **pair**, because the
 * callers that needed it held a pool and wanted both of its tokens. Gas
 * is not like that: it is spent in the chain's native token, which is
 * nobody's pool in particular, so there is no pair to ask about and no
 * pool address to hand over.
 *
 * Two sources, in the app's usual order:
 *
 *   1. **Moralis**, by block. Token-addressed, so it needs no pool. This
 *      is the preferred source and the only one that is exact to the
 *      moment rather than to the day.
 *   2. **GeckoTerminal** OHLCV, by day. Its historical endpoint is
 *      per-pool, so `getBestPoolForToken` resolves one first — and
 *      resolves which side of it the token sits on, which matters: read
 *      the wrong side of PLSX/WPLS and you get PLSX's price wearing
 *      WPLS's label.
 *
 * DexScreener is deliberately absent. It serves current prices only and
 * has no historical endpoint, so it cannot answer this question at all.
 *
 * **Cached by day, not by block.** A historical price never changes, so
 * entries never expire, and the day is the right granularity for what
 * this is used for: a hundred-odd rebalances spread over months collapse
 * to one lookup per day that saw activity, instead of one per event. The
 * cost is that two events on the same day are priced identically even
 * when Moralis could have separated them by block — which is the trade
 * the caller wants, since the alternative is hundreds of API calls to
 * move a gas figure by a fraction of a cent.
 *
 * A failed lookup answers `0`. Callers decide what that means; for gas,
 * zero must not be mistaken for "free", so the caller falls back rather
 * than recording it.
 */

"use strict";

const { log } = require("./log");
const {
  getHistoricalPrice,
  setHistoricalPrice,
  flushPriceCache,
  toUtcDayKey,
} = require("./price-cache");
const {
  _fetchMoralisHistorical,
  _fetchGeckoTerminalOhlcv,
} = require("./price-fetcher");
const {
  getBestPoolForToken,
  flushGeckoPoolCache,
} = require("./gecko-pool-cache");

/** GeckoTerminal leg: resolve a pool for the token, then read its candle. */
async function _viaGecko(tokenAddress, timestamp, network) {
  const best = await getBestPoolForToken(network, tokenAddress);
  flushGeckoPoolCache();
  if (!best) return 0;
  return _fetchGeckoTerminalOhlcv(best.pool, timestamp, best.side, network);
}

/**
 * A token's USD price on the UTC day containing `timestamp`.
 *
 * @param {string} tokenAddress      Token contract address.
 * @param {object} opts
 * @param {number} opts.timestamp    Unix seconds within the target day.
 * @param {number} [opts.blockNumber] Block for the Moralis leg. Without
 *   it Moralis is skipped and GeckoTerminal answers alone.
 * @param {string} [opts.network]    Internal chain name.
 * @param {boolean} [opts.refresh]   Read past the cache and overwrite it.
 * @returns {Promise<number>} USD price, or 0 when no source could answer.
 */
async function fetchHistoricalTokenPriceUsd(tokenAddress, opts = {}) {
  const { timestamp, blockNumber, network = "pulsechain" } = opts;
  if (typeof tokenAddress !== "string" || tokenAddress === "") return 0;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return 0;
  const dayKey = toUtcDayKey(timestamp);
  if (opts.refresh !== true) {
    const cached = getHistoricalPrice(network, tokenAddress, dayKey);
    if (cached !== null) return cached;
  }
  let price = 0;
  if (blockNumber !== undefined && blockNumber !== null)
    price = await _fetchMoralisHistorical(tokenAddress, blockNumber, network);
  if (price <= 0) price = await _viaGecko(tokenAddress, timestamp, network);
  if (price > 0) {
    setHistoricalPrice(network, tokenAddress, dayKey, price);
    flushPriceCache();
    return price;
  }
  log.warn(
    "[historical-price] no source could price %s on %s (block=%s)",
    tokenAddress,
    dayKey,
    blockNumber ?? "none",
  );
  return 0;
}

module.exports = {
  fetchHistoricalTokenPriceUsd,
};
