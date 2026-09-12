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
 * Classification data lives in `evm-rpc-response-codes.json` (read via
 * the layered defaults+user-override loader) so operators can tune
 * the substring lists at `app-config/user-configurable/evm-rpc-
 * response-codes.json` without touching code or shipped defaults.
 * EVM is the generic format — the same error shapes appear across all
 * EVM-compatible chains (PulseChain, Ethereum, Arbitrum, etc.).
 *
 * JSON-RPC code -32000 alone is a go-ethereum catch-all and is NOT used
 * for classification — the inner node message substring is the reliable
 * signal (see `innerErrorMessage`).
 */

"use strict";

const { loadMergedDefaults } = require("./load-merged-defaults");

const _FILENAME = "evm-rpc-response-codes.json";

/**
 * @typedef {object} ErrorBucket
 * @property {string}   description
 * @property {string[]} ethersCodes       ethers error code strings.
 * @property {string[]} messageSubstrings Lowercase substrings to match.
 */

/** @returns {{transient: ErrorBucket, terminalNonceUnused: ErrorBucket, terminalNonceConsumed: ErrorBucket}} */
function _loadBuckets() {
  const raw = loadMergedDefaults(_FILENAME);
  return {
    transient: raw.transient,
    terminalNonceUnused: raw.terminalNonceUnused,
    terminalNonceConsumed: raw.terminalNonceConsumed,
    blockRangeCap: raw.blockRangeCap,
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

/**
 * Does this error mean "your getLogs block range was too wide"?
 *
 * Deliberately NOT part of `classifyRpcError`'s three-bucket result:
 * those buckets answer "retry, or abort and what about the nonce?",
 * and none of the three fits.  A range-cap rejection is not transient
 * (the same request fails identically every time) and has no nonce
 * implication at all — it is a malformed request, and the fix is a
 * smaller chunk size rather than a retry or a different endpoint.
 *
 * Detection is by message substring because ethers hides the real code:
 * a JSON-RPC error arrives over HTTP 200, so `err.code` is the generic
 * `UNKNOWN_ERROR` and the `-32602` sits nested under `err.error.code`.
 * `innerErrorMessage` already walks down to the node's own text.
 * @param {*} err
 * @returns {boolean}
 */
function isBlockRangeCapError(err) {
  if (!err) return false;
  const bucket = _BUCKETS.blockRangeCap;
  if (!bucket || !Array.isArray(bucket.messageSubstrings)) return false;
  const msg = innerErrorMessage(err).toLowerCase();
  if (msg.length === 0) return false;
  return bucket.messageSubstrings.some((sub) => msg.includes(sub));
}

/**
 * Pull the block-count limit out of a range-cap message, when the
 * endpoint states one (e.g. "limited to a 10000 block range" → 10000).
 *
 * Best-effort: endpoints word these differently and some name no number
 * at all, so callers must handle null rather than assume a figure.
 * @param {*} err
 * @returns {number|null}
 */
function extractBlockRangeCap(err) {
  const msg = innerErrorMessage(err);
  const m = msg.match(/(\d[\d_,]{2,})/);
  if (!m) return null;
  const n = Number(m[1].replace(/[_,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  classifyRpcError,
  innerErrorMessage,
  isBlockRangeCapError,
  extractBlockRangeCap,
  getBuckets,
};
