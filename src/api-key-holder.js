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

/*- Whether a stored key may actually be used.  Separate from whether it
 *  exists, because the two answer different questions: the key dialog
 *  and its status dot care that a key is configured, while the price
 *  sources care whether to call the service at all.  An operator whose
 *  quota has run out wants to stop the calls without throwing the key
 *  away and having to paste it back later.
 *
 *  Absent means enabled — a service nobody has toggled behaves exactly
 *  as it did before this existed. */
const _enabled = {};

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

/**
 * Turn use of a stored key on or off, without discarding the key.
 * @param {string} service  Service name (e.g. "moralis").
 * @param {boolean} on      False to stop using it.
 */
function setServiceEnabled(service, on) {
  _enabled[service] = on !== false;
}

/**
 * May this service be used?  True unless explicitly turned off, so a
 * service nobody has toggled behaves as it always did.
 * @param {string} service  Service name.
 * @returns {boolean}
 */
function isServiceEnabled(service) {
  return _enabled[service] !== false;
}

module.exports = {
  setApiKey,
  getApiKey,
  setServiceEnabled,
  isServiceEnabled,
};
