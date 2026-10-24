/**
 * @file src/lib/price-service-urls.js
 * @module priceServiceUrls
 * @description
 * Where the price services live: the base url of each api the app asks
 * for token prices, from price-services.json. Every request to one of
 * them is built on these, so a service that moves its api is changed in
 * that one file.
 *
 * Read once, at load, and refused there when a value is not an https url
 * without a trailing slash. A request built on a bad base fails only when
 * a price is needed, and the moment a price is needed most is during a
 * rebalance.
 */

"use strict";

const { loadMergedDefaults } = require("./load-merged-defaults");
const { KINDS } = require("./value-kinds");

const _FILE = "price-services.json";

/**
 * One service's base url, checked.
 *
 * @param {object} cfg      The merged price-services.json.
 * @param {string} service  The service's key in it.
 * @returns {string} The base url.
 * @throws {Error} When it is not an https url without a trailing slash.
 */
function _baseUrl(cfg, service) {
  const url = cfg[service]?.baseUrl;
  if (KINDS.baseUrl.ok(url)) return url;
  throw new Error(
    `[config] ${_FILE} → ${service}.baseUrl must be ` +
      `${KINDS.baseUrl.what}; it is ${JSON.stringify(url)}.`,
  );
}

const _CFG = loadMergedDefaults(_FILE);

// DexScreener's api: current prices, no key.
const DEXSCREENER_API = _baseUrl(_CFG, "dexScreener");

// GeckoTerminal's api: current and historical prices, no key.
const GECKO_TERMINAL_API = _baseUrl(_CFG, "geckoTerminal");

// Moralis's api: current and historical prices, with the operator's key.
const MORALIS_API = _baseUrl(_CFG, "moralis");

module.exports = { DEXSCREENER_API, GECKO_TERMINAL_API, MORALIS_API };
