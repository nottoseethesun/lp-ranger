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
 *
 * Entries are keyed by the active chain and the address (`cacheKey`), so
 * a token at the same address on another chain never borrows this
 * chain's symbol.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { cacheKey } = require("./cache-store");
const { scanCachePath } = require("./scan-cache-dir");

/*-
 *  `TOKEN_SYMBOL_CACHE_PATH` moves the file, so a test that resolves
 *  symbols through the real path writes its fixture tokens somewhere of
 *  its own. Nothing expires an entry here, so a fixture written into the
 *  operator's file would stay.
 */
const _SYM_CACHE_PATH =
  process.env.TOKEN_SYMBOL_CACHE_PATH ||
  scanCachePath("token-symbol-cache.json");

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
  if (!addr) return null;
  _loadSymCache();
  return _symCache[cacheKey(config.CHAIN_NAME, addr)] || null;
}

/**
 * Store a symbol for an address.  Caller must invoke `flushSymbolCache()`
 * to persist; we avoid auto-flushing because callers usually batch many
 * writes (see `resolveSymbolMap`).
 */
function setTokenSymbol(addr, symbol) {
  if (!addr || !symbol) return;
  _loadSymCache();
  _symCache[cacheKey(config.CHAIN_NAME, addr)] = symbol;
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
