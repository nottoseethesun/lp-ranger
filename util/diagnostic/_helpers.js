/**
 * @file util/diagnostic/_helpers.js
 * @description
 * Pure helpers shared across the read-only diagnostic tools in
 * util/diagnostic/.  No project imports, no I/O — safe to require from
 * tests without mocking.  Anything tool-specific (config loading, RPC
 * scans, formatting tied to a specific tool's output table) stays in
 * the tool itself.
 *
 * Why this file exists:
 *   Three of the four tools all need to pad addresses into 32-byte
 *   topics, format unix timestamps for log lines, and sleep between
 *   RPC chunks.  Duplicating these caused a small drift risk and made
 *   testing awkward.  Centralising them here gives the test runner a
 *   single source of truth.
 *
 * Naming convention: the leading underscore in the filename signals
 * "internal to util/diagnostic/" — the diagnostics aren't a public API
 * surface, so the helpers don't need to be either.
 */

"use strict";

/** Sleep for `ms` milliseconds. Returns a Promise. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pad a 20-byte hex address into a 32-byte topic (lowercased,
 * left-zero-padded), suitable for use as an indexed-arg filter in
 * `eth_getLogs` topic slots.
 *
 * @param {string} addr — 0x-prefixed 20-byte hex address.
 * @returns {string} 0x-prefixed 32-byte topic.
 */
function addrTopic(addr) {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/**
 * Recover the 20-byte address from a 32-byte topic.  Returns the
 * EIP-55 checksummed form via ethers.getAddress.
 *
 * @param {string} topic — 0x-prefixed 32-byte topic.
 * @param {object} ethers — ethers module (passed in to keep this file
 *   free of hard ethers dependency for testing).
 * @returns {string} EIP-55 address.
 */
function addrFromTopic(topic, ethers) {
  return ethers.getAddress("0x" + topic.slice(-40));
}

/**
 * Format a unix-seconds timestamp as `YYYY-MM-DD HH:MM:SS UTC`, or
 * `—` when the input is falsy/unknown.  Used by every tool's log
 * table for human-readable timestamps.
 *
 * @param {number | null | undefined} unixSec
 * @returns {string}
 */
function fmtTs(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

module.exports = {
  sleep,
  addrTopic,
  addrFromTopic,
  fmtTs,
};
