/**
 * @file src/api-key-holder.js
 * @description
 * In-memory holder for decrypted third-party API keys.
 * Keys are set after wallet unlock and read by modules like
 * price-fetcher.js that need them at runtime.
 */

"use strict";

/** @type {Record<string, string>} */
const _keys = {};

/**
 * Store a decrypted API key in memory.
 * @param {string} service  Service name (e.g. "moralis").
 * @param {string} key      Plaintext API key.
 */
function setApiKey(service, key) {
  _keys[service] = key;
}

/**
 * Retrieve a decrypted API key.
 * @param {string} service  Service name.
 * @returns {string|null} Key or null if not available.
 */
function getApiKey(service) {
  return _keys[service] || null;
}

module.exports = { setApiKey, getApiKey };
