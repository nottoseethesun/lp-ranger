"use strict";

/**
 * @file test/helpers/price-stand-ins.js
 * @description Stand-ins for the two price lookups that ask price
 *   services over the network: a token's current USD price
 *   (`fetchTokenPriceUsd`) and the USD price of one unit of the dust
 *   threshold's reference asset (`fetchDustUnitPriceUsd`).
 *
 *   A test that drives a poll, a rebalance or a compound reaches both.
 *   Asked for real, they go to GeckoTerminal and DexScreener, so the
 *   result depends on a third party, and once the app's own GeckoTerminal
 *   budget of calls a minute fills, the test waits out the rest of the
 *   minute. Here each answers at once from a fixed table: the chain's
 *   wrapped native coin and the dust unit at steady prices, and every
 *   other token unpriced (0), which is what the price services answer for
 *   the made-up tokens the fixtures use.
 *
 *   The modules that read a price take the lookup when they load, so a
 *   test file requires this before any of them: at its top, after any
 *   setting the file moves and before anything else under src/lib/.
 */

const config = require("../../src/lib/config");

const PRICE_MODULE = require.resolve("../../src/lib/price-fetcher");
const real = require(PRICE_MODULE);

// USD for one of the chain's wrapped native coin, near PulseChain's.
const NATIVE_USD = 0.00003;

/*-
 *  USD for one troy ounce of gold, dust-threshold.json's reference asset:
 *  the price its shipped threshold of 1/4800 unit is set against, which
 *  makes the threshold $1.
 */
const DUST_UNIT_USD = 4800;

const _prices = new Map();
if (config.CHAIN.nativeWrappedToken)
  _prices.set(config.CHAIN.nativeWrappedToken.toLowerCase(), NATIVE_USD);

require.cache[PRICE_MODULE].exports = {
  ...real,
  fetchTokenPriceUsd: async (token) =>
    _prices.get(String(token).toLowerCase()) ?? 0,
  fetchDustUnitPriceUsd: async () => DUST_UNIT_USD,
};

module.exports = { NATIVE_USD, DUST_UNIT_USD };
