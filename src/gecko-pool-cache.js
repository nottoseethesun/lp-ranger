/**
 * @file src/gecko-pool-cache.js
 * @module geckoPoolCache
 * @description
 * Disk-backed JSON cache mapping `network-poolAddress` → token orientation.
 *
 * GeckoTerminal's `/networks/{network}/pools/{pool}/ohlcv/day?token=base|quote`
 * endpoint returns the OHLCV candle for the *base* or *quote* token of the pool.
 * GeckoTerminal's base/quote orientation is fixed at indexing time and is NOT
 * guaranteed to match a Uniswap v3 pool's `token0`/`token1` ordering. For some
 * pools (e.g. CRO/dickwifbutt on 9mm V3), `base = token1` and the prices come
 * back swapped — leading to wildly wrong USD valuations.
 *
 * This cache stores `'normal'` (base = token0) or `'flipped'` (base = token1)
 * per pool. The orientation is immutable, so entries never expire.
 *
 * Cache file: `tmp/gecko-pool-cache.json` (gitignored).
 * Lazy-loaded on first access; batched writes via dirty flag.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");
const { geckoRateLimit } = require("./gecko-rate-limit");

// Path can be overridden via env var so tests cannot ever clobber the
// production file, regardless of how the test is invoked.
const _CACHE_PATH =
  process.env.GECKO_POOL_CACHE_PATH ||
  path.join(process.cwd(), "tmp", "gecko-pool-cache.json");

/** @type {Record<string, 'normal'|'flipped'> | null} */
let _cache = null;
let _dirty = false;

/** Lazy-load the cache from disk. */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    _cache = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch {
    _cache = {};
  }
}

/** Build a cache key from network + pool address. */
function _key(network, poolAddress) {
  return `${network}-${poolAddress.toLowerCase()}`;
}

/**
 * Perform a single GeckoTerminal pool-info HTTP request.
 * Respects the shared GeckoTerminal rate limit before firing.
 * Returns `{ ok: boolean, status: number, baseAddr: string|null }`.
 */
async function _fetchPoolInfoOnce(network, poolAddress) {
  await geckoRateLimit();
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return { ok: false, status: r.status, baseAddr: null };
  const json = await r.json();
  const baseId = json?.data?.relationships?.base_token?.data?.id || "";
  const baseAddr = baseId.split("_").pop().toLowerCase() || null;
  return { ok: true, status: r.status, baseAddr };
}

/** Retry schedule for pool-info 429 responses (milliseconds per attempt). */
const _POOL_INFO_429_DELAYS_MS = [30_000, 30_000];

/**
 * Fetch and parse the base token address from GeckoTerminal pool info.
 * Retries on 429 with progressive delays since the orientation is a
 * one-time-per-pool lookup we really want to succeed. GeckoTerminal's free
 * tier is stricter on pool-info than OHLCV, and bot restarts within the
 * 60-second rate-limit window can trigger 429s even when our in-process
 * rate limiter says we have budget.
 */
async function _fetchBaseAddr(network, poolAddress) {
  try {
    let res = await _fetchPoolInfoOnce(network, poolAddress);
    let attempt = 0;
    while (
      !res.ok &&
      res.status === 429 &&
      attempt < _POOL_INFO_429_DELAYS_MS.length
    ) {
      const delay = _POOL_INFO_429_DELAYS_MS[attempt];
      log.warn(
        "[gecko-pool-cache] %s 429 — retry %d/%d in %ds",
        poolAddress,
        attempt + 1,
        _POOL_INFO_429_DELAYS_MS.length,
        delay / 1000,
      );
      await new Promise((r) => setTimeout(r, delay));
      res = await _fetchPoolInfoOnce(network, poolAddress);
      attempt++;
    }
    if (!res.ok) {
      log.warn(
        "[gecko-pool-cache] %s status=%d (final after %d retries)",
        poolAddress,
        res.status,
        attempt,
      );
      return null;
    }
    return res.baseAddr;
  } catch (err) {
    log.warn(
      "[gecko-pool-cache] %s fetch failed: %s",
      poolAddress,
      err.message ?? err,
    );
    return null;
  }
}

/** Compare GeckoTerminal base address to our token0/token1 → orientation. */
function _resolveOrientation(baseAddr, token0, token1, poolAddress) {
  if (!baseAddr) return null;
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (baseAddr === t0) return "normal";
  if (baseAddr === t1) return "flipped";
  log.warn(
    "[gecko-pool-cache] %s base=%s does not match token0=%s or token1=%s",
    poolAddress,
    baseAddr,
    t0,
    t1,
  );
  return null;
}

/**
 * Resolve the token orientation for a GeckoTerminal pool.
 * Returns `'normal'` if GeckoTerminal's base token == our token0,
 * or `'flipped'` if GeckoTerminal's base token == our token1.
 *
 * Hits the disk cache first, then falls back to a single GeckoTerminal pool
 * info request and persists the result.
 *
 * @param {string} network       GeckoTerminal network identifier.
 * @param {string} poolAddress   V3 pool contract address.
 * @param {string} token0        Our pool's token0 address.
 * @param {string} token1        Our pool's token1 address.
 * @returns {Promise<'normal'|'flipped'|null>} Orientation, or null on failure.
 */
async function getGeckoPoolOrientation(network, poolAddress, token0, token1) {
  if (!network || !poolAddress || !token0 || !token1) return null;
  _ensureLoaded();
  const k = _key(network, poolAddress);
  if (_cache[k]) return _cache[k];
  const baseAddr = await _fetchBaseAddr(network, poolAddress);
  const orientation = _resolveOrientation(
    baseAddr,
    token0,
    token1,
    poolAddress,
  );
  if (!orientation) return null;
  _cache[k] = orientation;
  _dirty = true;
  log.info(
    "[gecko-pool-cache] %s → %s (base=%s)",
    poolAddress,
    orientation,
    baseAddr,
  );
  return orientation;
}

/** Write the cache to disk if any new entries were added since last flush. */
function flushGeckoPoolCache() {
  if (!_dirty || !_cache) return;
  try {
    fs.mkdirSync(path.dirname(_CACHE_PATH), { recursive: true });
    fs.writeFileSync(_CACHE_PATH, JSON.stringify(_cache, null, 2), "utf8");
    _dirty = false;
  } catch (err) {
    log.warn("[gecko-pool-cache] Could not write cache:", err.message);
  }
}

/** Reset in-memory state (for testing). */
function _resetForTest() {
  _cache = null;
  _dirty = false;
}

module.exports = {
  getGeckoPoolOrientation,
  flushGeckoPoolCache,
  _resetForTest,
  _CACHE_PATH,
};
