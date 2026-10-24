/**
 * @file dashboard-chain-storage.js
 * @description The browser's per-chain copies of what the server
 *   scanned, kept in localStorage.
 *
 *   The server runs one chain for its life, but it can be restarted on
 *   another at the same address, and the browser's copies outlive it. A
 *   position cached for one chain must not be shown, or managed, as the
 *   other's, so each copy's key ends with the active chain:
 *   `9mm_position_store_<chain>` and so on.
 *
 *   Startup learns the chain from the server before it reads any of
 *   these copies, but the page's buttons work from the start, so a
 *   change to one can come first. Until the chain is known there is no
 *   key to use, and nothing is read or written: a key built from an
 *   unknown chain would end in `_null` and stay in the browser for good.
 *
 *   `dashboard-positions-store.js` keeps the position list and the
 *   managed set through `readChainScoped` and `writeChainScoped`. The
 *   last position viewed is read and remembered here, for the store and
 *   for `dashboard-positions.js` alike.
 */

import { activeChainId } from "./dashboard-chain.js";

/**
 * The key of one per-chain copy: its own name, then the active chain.
 *
 * @param {string} name  The key's own name, e.g. `9mm_position_store`.
 * @returns {string|null} The key, or null while the chain is unknown.
 */
function _chainScoped(name) {
  const chain = activeChainId();
  return chain === null ? null : name + "_" + chain;
}

/**
 * Read one per-chain copy.
 *
 * @param {string} name  The key's own name.
 * @returns {string|null} What is stored, or null when nothing is or
 *   while the chain is unknown.
 */
export function readChainScoped(name) {
  const key = _chainScoped(name);
  return key === null ? null : localStorage.getItem(key);
}

/**
 * Write one per-chain copy. Nothing is written while the chain is
 * unknown.
 *
 * @param {string} name   The key's own name.
 * @param {string} value  What to store.
 */
export function writeChainScoped(name, value) {
  const key = _chainScoped(name);
  if (key !== null) localStorage.setItem(key, value);
}

/** The last position viewed on the active chain, or null. */
export function readLastPosition() {
  return readChainScoped("9mm_last_position");
}

/** Remember `tokenId` as the last position viewed on the active chain. */
export function rememberLastPosition(tokenId) {
  writeChainScoped("9mm_last_position", String(tokenId));
}
