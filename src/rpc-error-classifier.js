/**
 * @file rpc-error-classifier.js
 * @description Classify RPC/ethers errors into three buckets for the
 * rebalancer retry logic:
 *
 *   - "transient"               Safe to retry after a short backoff.
 *                               The TX may not have been broadcast.
 *                               Reset the NonceManager before retry so
 *                               the next attempt picks up the correct
 *                               chain-state nonce.
 *   - "terminal-nonce-unused"   Node rejected the TX before it was
 *                               admitted to the executable pending pool.
 *                               The nonce was never consumed, so the
 *                               NonceManager must be reset, and the
 *                               caller must abort (not retry) — the
 *                               cause is usually persistent saturation
 *                               or a bad param.
 *   - "terminal-nonce-consumed" The nonce is already used on-chain.
 *                               Abort without touching the NonceManager.
 *   - "unknown"                 Unrecognised shape. Caller should treat
 *                               as terminal-nonce-consumed (the safe
 *                               default — don't retry, don't reset).
 *
 * Classification data lives in
 * `app-config/static-tunables/evm-rpc-response-codes.json` so operators
 * can tune the substring lists without touching code.  EVM is the
 * generic format — the same error shapes appear across all EVM-compatible
 * chains (PulseChain, Ethereum, Arbitrum, etc.).
 *
 * JSON-RPC code -32000 alone is a go-ethereum catch-all and is NOT used
 * for classification — the inner node message substring is the reliable
 * signal (see `innerErrorMessage`).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const _JSON_PATH = path.join(
  __dirname,
  "..",
  "app-config",
  "static-tunables",
  "evm-rpc-response-codes.json",
);

/**
 * @typedef {object} ErrorBucket
 * @property {string}   description
 * @property {string[]} ethersCodes       ethers error code strings.
 * @property {string[]} messageSubstrings Lowercase substrings to match.
 */

/** @returns {{transient: ErrorBucket, terminalNonceUnused: ErrorBucket, terminalNonceConsumed: ErrorBucket}} */
function _loadBuckets() {
  const raw = JSON.parse(fs.readFileSync(_JSON_PATH, "utf8"));
  return {
    transient: raw.transient,
    terminalNonceUnused: raw.terminalNonceUnused,
    terminalNonceConsumed: raw.terminalNonceConsumed,
  };
}

const _BUCKETS = _loadBuckets();

/** Safely walk a key path on an object, returning undefined on any null hop. */
function _safeGet(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Paths checked by `innerErrorMessage`, in order of specificity. The
 * first path that resolves to a non-empty string wins.
 */
const _MESSAGE_PATHS = [
  ["info", "error", "message"],
  ["error", "message"],
  ["info", "responseBody"],
  ["error", "body"],
  ["cause", "message"],
  ["shortMessage"],
  ["reason"],
  ["message"],
];

/**
 * Extract the verbatim inner error message from an ethers-wrapped RPC
 * error.  ethers nests the node's message several layers deep under
 * `err.info.error.message`, `err.error.body`, `err.shortMessage`, etc.
 * Returns the deepest string found, or the top-level `err.message`.
 * @param {*} err
 * @returns {string}
 */
function innerErrorMessage(err) {
  if (!err) return "";
  for (const path of _MESSAGE_PATHS) {
    const v = _safeGet(err, path);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return String(err);
}

/**
 * Check whether any substring in `patterns` appears in `msg`.
 * Both `msg` and the patterns must be lowercased before calling.
 * @param {string}   msg
 * @param {string[]} patterns
 */
function _matchesAny(msg, patterns) {
  for (const p of patterns) {
    if (msg.includes(p)) return true;
  }
  return false;
}

/**
 * Classify an error into one of four buckets.
 * @param {*} err
 * @returns {"transient"|"terminal-nonce-unused"|"terminal-nonce-consumed"|"unknown"}
 */
function classifyRpcError(err) {
  if (!err) return "unknown";
  const code = typeof err.code === "string" ? err.code : "";
  const msg = innerErrorMessage(err).toLowerCase();

  // Check nonce-consumed first — if the node says "nonce too low" we
  // never want to retry, even if another substring (e.g. "server error")
  // also matches.
  const nc = _BUCKETS.terminalNonceConsumed;
  if (nc.ethersCodes.includes(code) || _matchesAny(msg, nc.messageSubstrings)) {
    return "terminal-nonce-consumed";
  }
  const nu = _BUCKETS.terminalNonceUnused;
  if (nu.ethersCodes.includes(code) || _matchesAny(msg, nu.messageSubstrings)) {
    return "terminal-nonce-unused";
  }
  const tr = _BUCKETS.transient;
  if (tr.ethersCodes.includes(code) || _matchesAny(msg, tr.messageSubstrings)) {
    return "transient";
  }
  return "unknown";
}

/**
 * Expose the loaded buckets (read-only) for diagnostics and tests.
 * @returns {{transient: ErrorBucket, terminalNonceUnused: ErrorBucket, terminalNonceConsumed: ErrorBucket}}
 */
function getBuckets() {
  return _BUCKETS;
}

module.exports = {
  classifyRpcError,
  innerErrorMessage,
  getBuckets,
};
