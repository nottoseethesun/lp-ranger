/**
 * @file token-symbol-cache.js
 * @module token-symbol-cache
 * @description
 * Disk-backed cache mapping ERC-20 token addresses to their human-readable
 * symbols.  Extracted from `server-scan.js` so dependency-light modules
 * (e.g. `price-fetcher.js`) can resolve symbols for log lines without
 * pulling in server-scan's heavy transitive deps (pool-scanner, rebalancer,
 * etc.) and risking a circular import.
 *
 * The cache is populated by `server-scan.resolveSymbolMap()` during LP
 * position scans; readers fall back to `null` when the address has not
 * been seen yet and the caller can degrade gracefully (e.g. show the
 * address only).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const _SYM_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "token-symbol-cache.json",
);

/** Lazy-loaded in-memory mirror of the JSON file on disk. */
let _symCache = null;

function _loadSymCache() {
  if (_symCache) return;
  try {
    _symCache = JSON.parse(fs.readFileSync(_SYM_CACHE_PATH, "utf8"));
  } catch {
    _symCache = {};
  }
}

/** Persist the in-memory cache to disk (best-effort; swallows fs errors). */
function flushSymbolCache() {
  if (!_symCache) return;
  try {
    fs.mkdirSync(path.dirname(_SYM_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      _SYM_CACHE_PATH,
      JSON.stringify(_symCache, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Get a cached token symbol by address.
 * @param {string} addr  Token contract address (case-insensitive).
 * @returns {string|null} Symbol if cached, otherwise null.
 */
function getTokenSymbol(addr) {
  _loadSymCache();
  return _symCache[(addr || "").toLowerCase()] || null;
}

/**
 * Store a symbol for an address.  Caller must invoke `flushSymbolCache()`
 * to persist; we avoid auto-flushing because callers usually batch many
 * writes (see `resolveSymbolMap`).
 */
function setTokenSymbol(addr, symbol) {
  if (!addr || !symbol) return;
  _loadSymCache();
  _symCache[addr.toLowerCase()] = symbol;
}

/** Reset the in-memory cache (tests only). */
function _resetSymbolCache() {
  _symCache = null;
}

module.exports = {
  getTokenSymbol,
  setTokenSymbol,
  flushSymbolCache,
  _resetSymbolCache,
  _SYM_CACHE_PATH,
};
