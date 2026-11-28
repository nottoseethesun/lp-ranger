/**
 * @file token-symbol-cache.js
 * @module token-symbol-cache
 * @description
 * Disk-backed cache mapping ERC-20 token addresses to their human-readable
 * symbols. It is kept apart from `src/bot/wallet-scan.js`, which fills it,
 * so dependency-light modules (e.g. `price-fetcher.js`) can resolve
 * symbols for log lines without pulling in the wallet scan's heavy
 * dependencies (pool-scanner, rebalancer, etc.) and risking a circular
 * import.
 *
 * The cache is populated by `wallet-scan.resolveSymbolMap()` during LP
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
const { tellFileProblem } = require("./file-problem");
const { cacheKey } = require("./cache-store");
const { scanCachePath } = require("./scan-cache-dir");
const { readEnv } = require("./env-settings");

/*-
 *  `TOKEN_SYMBOL_CACHE_PATH` moves the file, read through `readEnv`, so a
 *  blank value names none; a test that resolves symbols through the real
 *  path writes its fixture tokens somewhere of its own. Nothing expires
 *  an entry here, so a fixture written into the operator's file would
 *  stay.
 */
const _SYM_CACHE_PATH =
  readEnv("TOKEN_SYMBOL_CACHE_PATH") ??
  scanCachePath("token-symbol-cache.json");

/** Lazy-loaded in-memory mirror of the JSON file on disk. */
let _symCache = null;

function _loadSymCache() {
  if (_symCache) return;
  try {
    _symCache = JSON.parse(fs.readFileSync(_SYM_CACHE_PATH, "utf8"));
  } catch (err) {
    // Start empty; a file there that cannot be read is told.
    tellFileProblem({ doing: "read", file: _SYM_CACHE_PATH, err });
    _symCache = {};
  }
}

/**
 * Persist the in-memory cache to disk; a failure is told as every caught
 * file failure is (src/lib/file-problem.js), never thrown.
 */
function flushSymbolCache() {
  if (!_symCache) return;
  try {
    fs.mkdirSync(path.dirname(_SYM_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      _SYM_CACHE_PATH,
      JSON.stringify(_symCache, null, 2),
      "utf8",
    );
  } catch (err) {
    tellFileProblem({ doing: "write to", file: _SYM_CACHE_PATH, err });
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
