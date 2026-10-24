"use strict";

/**
 * @file util/bookkeeping/usd-prices.js
 * @module bookkeeping/usd-prices
 * @description
 * A coin's price in USD for a transaction, from LP Ranger's own price
 * library rather than a copy of it: `fetchHistoricalTokenPriceUsd`
 * (src/lib/historical-token-price.js), the lookup the app uses to price gas
 * on a past day. It prices one coin by its address, so the one call
 * serves a pool's two coins, the chain's own coin through its wrapped
 * form, and any other coin.
 *
 * Two price oracles answer, in the library's order. Moralis comes first,
 * pricing the coin at the transaction's block, as far back as the chain
 * goes. This module passes the block, and `./moralis-key.js` has put the
 * key in memory before the run prices anything. Where Moralis has no
 * price, CoinGecko answers, through GeckoTerminal: the closing price of
 * the UTC day the block falls in, and only for the last 180 days. The
 * library keeps one price per coin per UTC day, the first it was given,
 * so each later transaction that day takes that price. No rpc endpoint
 * is asked.
 *
 * The library keeps what it fetches on disk, in two cache files, and
 * reads their paths as it loads. This module points both at the
 * bookkeeping tools' own folder, `app-data/util/bookkeeping/scan-cache/`,
 * before the library loads, so the app's caches stay the app's. One run
 * of the report at a time writes the tools' copies, under the lock
 * `./price-cache-lock.js` takes beside them (`cachePath`). Under
 * `node --test` the files go to the test process's own folder instead
 * (src/lib/scan-cache-dir.js), so a test never reaches the install's.
 *
 * The library loads LP Ranger's configuration (src/lib/config.js), and with
 * it the chain the prices are for, so `./blockchain` is required first:
 * it settles that chain from `--blockchain` before the configuration
 * reads it.
 *
 * A lookup that finds no price is not a price of zero, so `usdPriceOn`
 * throws instead, with `priceUnavailable` set on the error, and the
 * caller stops: this tool asks no third price source.
 */

const path = require("path");
require("./blockchain");
const { scanCachePath } = require("../../src/lib/scan-cache-dir");

/** The bookkeeping tools' own cache folder, beside their reports. */
const CACHE_DIR = path.resolve(
  __dirname,
  "../../app-data/util/bookkeeping/scan-cache",
);

/**
 * Where one of the library's cache files goes: the tools' own folder, or
 * the test process's own under `node --test`, as src/lib/scan-cache-dir.js
 * decides for the app's.
 * @param {string} fileName
 * @returns {string}
 */
function cachePath(fileName) {
  return process.env.NODE_TEST_CONTEXT === undefined
    ? path.join(CACHE_DIR, fileName)
    : scanCachePath(fileName);
}

/*-
 *  Set before the price library loads, since price-cache.js and
 *  gecko-pool-cache.js read these paths as they load.
 */
process.env.PRICE_CACHE_PATH = cachePath("historical-price-cache.json");
process.env.GECKO_POOL_CACHE_PATH = cachePath("gecko-pool-cache.json");

const {
  fetchHistoricalTokenPriceUsd,
} = require("../../src/lib/historical-token-price");

/**
 * What a run that stops for want of a price tells the user to do.
 */
const PRICE_ADVICE =
  "This tool asks two price oracles, Moralis and then CoinGecko through " +
  "GeckoTerminal, and falls back to no other. Consider trying a " +
  "different price oracle, or these again later. GeckoTerminal reaches " +
  "back only 180 days, so an older day's price must come from Moralis.";

/**
 * The UTC day a moment falls in, as YYYY-MM-DD.
 * @param {number} timestamp  Unix seconds.
 * @returns {string}
 */
function utcDay(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/**
 * A coin's USD price for a transaction: Moralis's at its block, or
 * CoinGecko's for its UTC day.
 *
 * @param {string} coin  The coin's address.
 * @param {{timestamp: number, blockNumber: number}} moment  The block's
 *   time, in Unix seconds, and the block.
 * @param {Function} [fetchPrice]  The lookup, `fetchHistoricalTokenPriceUsd`
 *   unless a test passes a stand-in.
 * @returns {Promise<number>}  The price, above zero.
 * @throws {Error}  With `priceUnavailable` set, when the lookup fails or
 *   finds no price.
 */
async function usdPriceOn(
  coin,
  { timestamp, blockNumber },
  fetchPrice = fetchHistoricalTokenPriceUsd,
) {
  let price;
  try {
    price = await fetchPrice(coin, { timestamp, blockNumber });
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    throw Object.assign(error, { priceUnavailable: true });
  }
  if (typeof price === "number" && Number.isFinite(price) && price > 0)
    return price;
  const error = new Error(
    `Neither Moralis nor CoinGecko (GeckoTerminal) gave a USD price for ` +
      `${coin} at block ${blockNumber}, on ${utcDay(timestamp)} (UTC)`,
  );
  throw Object.assign(error, { priceUnavailable: true });
}

module.exports = {
  CACHE_DIR,
  PRICE_ADVICE,
  cachePath,
  utcDay,
  usdPriceOn,
};
