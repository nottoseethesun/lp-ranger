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
 * It also answers the other GeckoTerminal pool question the app has to
 * ask: given a bare token, which pool should its price be read from?
 * That is needed for a historical price, because GeckoTerminal's OHLCV
 * endpoint is per-pool while its token endpoint serves only the current
 * price. Those entries are keyed under a `token:` prefix so the two
 * kinds cannot collide.
 *
 * Cache file: `tmp/gecko-pool-cache.json` (gitignored).
 * Lazy-loaded on first access; batched writes via dirty flag.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");
const { geckoRateLimit } = require("./gecko-rate-limit");
const { retryOn429 } = require("./price-source-backoff");

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

/**
 * Run a one-shot GeckoTerminal request, retrying a 429.
 *
 * Shared by both lookups in this file because both are once-per-subject
 * and both hit the endpoints the free tier is strictest on. A restart
 * inside the 60-second rate-limit window can draw a 429 even when the
 * in-process limiter says there is budget, and a 429 that is not retried
 * does not merely slow something down: the answer is cached on success
 * only, so the subject goes unresolved for the life of the process.
 *
 * The schedule and the cross-call escalation are NOT kept here. Both
 * belong to `price-source-backoff.js`, because a refusal of this
 * endpoint and a refusal of the OHLCV endpoint in `price-fetcher.js`
 * are the same service refusing the same process — a schedule private
 * to either one cannot slow the other, and the thing that needs slowing
 * is every call.
 *
 * @param {string} label            What is being looked up, for the log.
 * @param {() => Promise<{ok: boolean, status: number}>} fetchOnce
 * @returns {Promise<object>} The final response, ok or not.
 */
async function _with429Retry(label, fetchOnce) {
  const res = await retryOn429({ source: "gecko", label, fetchOnce });
  if (!res.ok)
    log.warn("[gecko-pool-cache] %s status=%d (final)", label, res.status);
  return res;
}

/**
 * Fetch and parse the base token address from GeckoTerminal pool info.
 *
 * @param {string} network      GeckoTerminal network identifier.
 * @param {string} poolAddress  Pool contract address.
 * @returns {Promise<string|null>} Base token address, or null on failure.
 */
async function _fetchBaseAddr(network, poolAddress) {
  try {
    const res = await _with429Retry(poolAddress, () =>
      _fetchPoolInfoOnce(network, poolAddress),
    );
    if (!res.ok) return null;
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

/*-
 *  How many of the service's own top-ranked pools to consider. Ten is
 *  deep enough that a token with several thin pairs still reaches a real
 *  one, and shallow enough that the list stays the service's opinion of
 *  the token's main market rather than a sweep of every pair it sits in.
 */
const _TOP_POOLS_CONSIDERED = 10;

/** Build a cache key from network + token address. */
function _tokenKey(network, tokenAddress) {
  return `token:${network}-${tokenAddress.toLowerCase()}`;
}

/** Address out of a GeckoTerminal token id such as `pulsechain_0xabc…`. */
function _addrOf(tokenId) {
  return String(tokenId || "")
    .split("_")
    .pop()
    .toLowerCase();
}

/**
 * Which side of the pool the token sits on, as GeckoTerminal indexed it.
 * The OHLCV endpoint is asked for `base` or `quote`, so this is the same
 * question `getGeckoPoolOrientation` answers for a known pair — but the
 * token-pools response already carries it, so resolving it here saves a
 * second request per pool.
 */
function _sideOf(pool, tokenAddress) {
  const want = tokenAddress.toLowerCase();
  if (_addrOf(pool?.relationships?.base_token?.data?.id) === want)
    return "base";
  if (_addrOf(pool?.relationships?.quote_token?.data?.id) === want)
    return "quote";
  return null;
}

/** One GeckoTerminal token-pools request. Returns `{ok, status, pools}`. */
async function _fetchTokenPoolsOnce(network, tokenAddress) {
  await geckoRateLimit();
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}` +
    `/tokens/${tokenAddress.toLowerCase()}/pools`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return { ok: false, status: r.status, pools: [] };
  const json = await r.json();
  const pools = (json?.data || []).map((p) => ({
    address: p?.attributes?.address || "",
    name: p?.attributes?.name || "",
    liquidity: Number(p?.attributes?.reserve_in_usd ?? 0),
    volume: Number(p?.attributes?.volume_usd?.h24 ?? 0),
    side: _sideOf(p, tokenAddress),
  }));
  return { ok: true, status: r.status, pools };
}

/**
 * Choose the pool to read a token's price from.
 *
 * Deepest first, skipping any pool that is not trading. Depth decides
 * whose candles actually track the token rather than a thin quote, and a
 * pool with no volume has no candle to read at all — so it is passed
 * over here rather than chosen and found empty later, when the caller
 * can no longer tell "no trade that day" from "wrong pool".
 *
 * A pool the token is on neither side of is dropped too: the OHLCV
 * endpoint can only be asked for `base` or `quote`, so there would be no
 * way to read this token's price out of it.
 *
 * @param {Array<{address: string, liquidity: number, volume: number,
 *   side: string|null}>} pools
 * @returns {object|null} The chosen pool, or null when none is trading.
 */
function _pickBestPool(pools) {
  const candidates = pools
    .slice(0, _TOP_POOLS_CONSIDERED)
    .filter((p) => p.address && p.volume > 0 && p.side !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) =>
    p.liquidity > best.liquidity ? p : best,
  );
}

/**
 * Resolve which GeckoTerminal pool a token's price should be read from.
 *
 * Hits the disk cache first, then asks GeckoTerminal for the token's
 * pools and applies `_pickBestPool`.
 *
 * Unlike an orientation, a pool choice is not immutable — liquidity
 * moves. It is cached without expiry anyway, because a stale choice
 * cannot produce a wrong number: the pool it names either still has
 * candles, in which case it is still a real market for the token, or it
 * does not, in which case the OHLCV read answers zero and the caller
 * falls through to its next source. The failure mode is a missing
 * price, never a misleading one.
 *
 * @param {string} network       GeckoTerminal network identifier.
 * @param {string} tokenAddress  Token contract address.
 * @returns {Promise<{pool: string, side: 'base'|'quote'}|null>} The pool to
 *   read from and which side of it the token is, or null when none found.
 */
async function getBestPoolForToken(network, tokenAddress) {
  if (!network || !tokenAddress) return null;
  _ensureLoaded();
  const k = _tokenKey(network, tokenAddress);
  if (_cache[k] !== undefined && _cache[k] !== null) return _cache[k];
  let res;
  try {
    res = await _with429Retry(`token-pools ${tokenAddress}`, () =>
      _fetchTokenPoolsOnce(network, tokenAddress),
    );
  } catch (err) {
    log.warn(
      "[gecko-pool-cache] token-pools %s fetch failed: %s",
      tokenAddress,
      err.message ?? err,
    );
    return null;
  }
  if (!res.ok) return null;
  const best = _pickBestPool(res.pools);
  if (!best) {
    log.warn(
      "[gecko-pool-cache] token-pools %s — no trading pool among the top %d",
      tokenAddress,
      _TOP_POOLS_CONSIDERED,
    );
    return null;
  }
  _cache[k] = { pool: best.address, side: best.side };
  _dirty = true;
  log.info(
    "[gecko-pool-cache] %s price pool → %s (%s, %s side, liquidity $%s, 24h volume $%s)",
    tokenAddress,
    best.address,
    best.name,
    best.side,
    best.liquidity.toFixed(0),
    best.volume.toFixed(0),
  );
  return _cache[k];
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
  getBestPoolForToken,
  flushGeckoPoolCache,
  _pickBestPool, // exported for tests
  _resetForTest,
  _CACHE_PATH,
};
