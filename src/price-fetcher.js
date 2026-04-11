/**
 * @file price-fetcher.js
 * @module price-fetcher
 * @description
 * Fetches USD prices for tokens on PulseChain for the 9mm v3 Position Manager.
 *
 * Uses three price sources in priority order: Moralis (primary, requires
 * API key, most reliable for meme tokens), GeckoTerminal (free, rate-limited
 * 30/min), and DexScreener (free, but drops tokens with no 24h LP activity).
 * Results are cached in memory with a 60-second TTL.
 *
 * GeckoTerminal rate limiting
 * ──────────────────────────
 * The free GeckoTerminal OHLCV API allows 30 calls/min.  A centralized
 * sliding-window rate limiter (`geckoRateLimit()` from `gecko-rate-limit.js`) is applied inside
 * `_fetchGeckoTerminalOhlcv()` so ALL callers (HODL baseline, epoch
 * reconstruction, position history) share a single budget.  If the
 * window is full the caller automatically waits until a slot opens.
 *
 * Inspired by {@link https://github.com/nottoseethesun/crypto-price-fetchers}.
 *
 * @example
 * const { fetchTokenPriceUsd } = require('./price-fetcher');
 * const price = await fetchTokenPriceUsd('0xA1077a...', { chain: 'pulsechain' });
 * console.log(`Token price: $${price}`);
 */

"use strict";

const {
  getHistoricalPrice,
  setHistoricalPrice,
  flushPriceCache,
  toUtcDayKey,
} = require("./price-cache");
const { getApiKey } = require("./api-key-holder");
const { geckoRateLimit, noteGecko429 } = require("./gecko-rate-limit");
const {
  getGeckoPoolOrientation,
  flushGeckoPoolCache,
} = require("./gecko-pool-cache");

// ── constants ────────────────────────────────────────────────────────────────

/** @type {number} Cache time-to-live in milliseconds (60 seconds). */
const _CACHE_TTL_MS = 60_000;

/**
 * In-memory price cache.
 * Keys are `{chain}:{tokenAddress}` (lower-cased).
 * Values are `{ price: number, ts: number }`.
 * @type {Map<string, { price: number, ts: number }>}
 */
const _cache = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a deterministic cache key for a given chain and token address.
 * @param {string} chain        - Chain identifier (e.g. 'pulsechain').
 * @param {string} tokenAddress - ERC-20 contract address.
 * @returns {string} Cache key.
 */
function _cacheKey(chain, tokenAddress) {
  return `${chain}:${tokenAddress.toLowerCase()}`;
}

// ── DexScreener ──────────────────────────────────────────────────────────────

/**
 * Fetch USD price for a token from the DexScreener API.
 *
 * Filters the returned pairs to those on the requested chain and selects the
 * pair with the highest USD liquidity.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} [chain='pulsechain'] - Chain identifier used to filter pairs.
 * @returns {Promise<number>} USD price (0 if unavailable or on error).
 */
async function _fetchDexScreener(tokenAddress, chain = "pulsechain") {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    return 0;
  }

  const json = await res.json();
  const pairs = json?.pairs;

  if (!Array.isArray(pairs) || pairs.length === 0) {
    return 0;
  }

  // Filter to the requested chain.
  const chainPairs = pairs.filter((p) => p.chainId === chain);

  if (chainPairs.length === 0) {
    return 0;
  }

  // Select the pair with the highest USD liquidity.
  const best = chainPairs.reduce((a, b) => {
    const liqA = Number(a?.liquidity?.usd ?? 0);
    const liqB = Number(b?.liquidity?.usd ?? 0);
    return liqB > liqA ? b : a;
  });

  const price = Number(best?.priceUsd ?? 0);
  return Number.isFinite(price) ? price : 0;
}

// ── GeckoTerminal (current price) ────────────────────────────────────────────

/**
 * Fetch current USD price for a token from the GeckoTerminal simple price API.
 *
 * Uses the same rate limiter as the OHLCV endpoint to share the 30 calls/min
 * budget.  Returns 0 if the token is not found or on error.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} [network='pulsechain'] - GeckoTerminal network identifier.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchGeckoTerminalCurrent(
  tokenAddress,
  network = "pulsechain",
) {
  await geckoRateLimit();
  const url =
    `https://api.geckoterminal.com/api/v2/simple/networks/${network}` +
    `/token_price/${tokenAddress.toLowerCase()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return 0;
  const json = await res.json();
  const prices = json?.data?.attributes?.token_prices;
  if (!prices) return 0;
  const price = Number(prices[tokenAddress.toLowerCase()]);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

// ── price source chain ──────────────────────────────────────────────────────

/**
 * Try a list of price sources in priority order, returning the first
 * non-zero result.  Each source is { name, fn } where fn is an async
 * function returning a USD price (0 = unavailable).  Errors are caught
 * and logged so callers never receive a rejected promise.
 *
 * @param {{ name: string, fn: () => Promise<number> }[]} sources
 * @returns {Promise<number>} USD price (0 if all sources fail).
 */
async function tryPriceSources(sources) {
  for (const { name, fn } of sources) {
    try {
      const price = await fn();
      if (price > 0) return price;
    } catch (err) {
      console.warn(`[price-fetcher] ${name} error:`, err.message ?? err);
    }
  }
  return 0;
}

// ── main entry point ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} FetchTokenPriceOpts
 * @property {string} [chain='pulsechain']  Chain identifier.
 */

/**
 * Fetch the current USD price for a token on PulseChain.
 *
 * Resolution order:
 *  1. Return cached value if still within the TTL window.
 *  2. Try Moralis (requires API key — most reliable for meme tokens).
 *  3. Try GeckoTerminal (free, no API key, rate-limited 30/min).
 *  4. Try DexScreener (free, no API key — drops tokens with no 24h activity).
 *  5. Return 0 if all sources fail or return no data.
 *
 * All network errors are caught and logged via `console.warn` so that
 * callers never receive a rejected promise.
 *
 * @param {string}              tokenAddress - ERC-20 contract address.
 * @param {FetchTokenPriceOpts} [opts={}]    - Optional configuration.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function fetchTokenPriceUsd(tokenAddress, opts = {}) {
  const chain = opts.chain ?? "pulsechain";
  const key = _cacheKey(chain, tokenAddress);

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < _CACHE_TTL_MS) return cached.price;

  const price = await tryPriceSources([
    { name: "Moralis", fn: () => _fetchMoralisCurrent(tokenAddress, chain) },
    {
      name: "GeckoTerminal",
      fn: () => _fetchGeckoTerminalCurrent(tokenAddress, chain),
    },
    { name: "DexScreener", fn: () => _fetchDexScreener(tokenAddress, chain) },
  ]);
  if (price > 0) _cache.set(key, { price, ts: Date.now() });
  return price;
}

// ── GeckoTerminal (historical prices) ────────────────────────────────────────
// Rate limiting lives in `gecko-rate-limit.js` and is shared with
// `gecko-pool-cache.js` so all GeckoTerminal calls use a single budget.

/**
 * Fetch a single OHLCV candle from GeckoTerminal at the given timeframe.
 * Internal helper — prefer `_fetchGeckoTerminalOhlcv` which cascades across
 * timeframes when finer ones are needed.
 *
 * Uses **end-of-UTC-day** as the `before_timestamp` (not `timestamp + 1h`)
 * so the returned candle is the latest one from the block's day. For the
 * pool-inception case — a block at pool creation where trading hadn't
 * started yet — a narrow look-ahead would return nothing, but by the end
 * of the day candles usually exist. The end-of-day candle is still
 * strictly "historical (same day as mint)" and is much more useful than
 * today's current-price fallback.
 *
 * @param {string} poolAddress  V3 pool contract address.
 * @param {number} timestamp    Unix seconds for the target moment.
 * @param {'base'|'quote'} token Which pool token to price.
 * @param {string} network      GeckoTerminal network identifier.
 * @param {'day'|'hour'|'minute'} timeframe  Candle granularity.
 * @returns {Promise<number>}  USD close price (0 if unavailable).
 */
/**
 * Retry delays (ms) when GeckoTerminal OHLCV returns HTTP 429. The first
 * delay (3s) gives the server's short-term burst counter a moment to drain;
 * the second (10s) covers longer cool-downs. Kept short enough that the worst
 * case per call (~13s) doesn't blow up the test suite, long enough that we
 * usually recover a genuine transient rate limit.
 *
 * Exposed via `_setOhlcv429Delays` so tests can shrink them to near-zero.
 * @type {number[]}
 */
let _ohlcv429DelaysMs = [3_000, 10_000];

/** Override the OHLCV 429 retry schedule (tests only). */
function _setOhlcv429Delays(delays) {
  _ohlcv429DelaysMs = delays;
}

/**
 * Perform one OHLCV HTTP request. Returns `{ status, close }`:
 *  - `status` is the HTTP response code (0 on network/parse error).
 *  - `close` is the numeric close price or 0 when unavailable.
 *
 * Splitting this from the retry wrapper lets the caller distinguish 429
 * (retry) from 200-with-empty-list (genuine no-data, no retry).
 */
async function _fetchOhlcvOnce(url, timeframe) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { status: res.status, close: 0 };
    const json = await res.json();
    const candles = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || candles.length === 0)
      return { status: 200, close: 0 };
    // Candle format: [timestamp, open, high, low, close, volume]
    const close = Number(candles[0][4]);
    return { status: 200, close: Number.isFinite(close) ? close : 0 };
  } catch (err) {
    console.warn(
      "[price-fetcher] GeckoTerminal OHLCV error (%s): %s",
      timeframe,
      err.message ?? err,
    );
    return { status: 0, close: 0 };
  }
}

async function _fetchGeckoOhlcvAtTimeframe(
  poolAddress,
  timestamp,
  token,
  network,
  timeframe,
) {
  await geckoRateLimit();
  // End of the UTC day the timestamp falls in. `limit=1` returns the
  // most recent candle whose close time is ≤ `before_timestamp`.
  const dayStart = Math.floor(timestamp / 86400) * 86400;
  const before = dayStart + 86400;
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}` +
    `/pools/${poolAddress}/ohlcv/${timeframe}` +
    `?before_timestamp=${before}&limit=1&currency=usd&token=${token}`;
  let res = await _fetchOhlcvOnce(url, timeframe);
  // Retry 429s: GeckoTerminal enforces a server-side rate limit on top of
  // our in-process limiter (the limiter tracks our intent, not their
  // counter). During startup bursts Gecko trips even when our limiter says
  // OK. A 429 means "retry later", distinct from "no data" — retry it with
  // backoff AND push the shared gecko-rate-limit window forward so
  // subsequent callers in the same burst also back off, preventing a cascade
  // of 429s.
  for (let i = 0; res.status === 429 && i < _ohlcv429DelaysMs.length; i++) {
    const delay = _ohlcv429DelaysMs[i];
    noteGecko429(delay);
    console.warn(
      "[price-fetcher] GeckoTerminal OHLCV %s pool=%s 429 — retry %d/%d in %dms",
      timeframe,
      poolAddress,
      i + 1,
      _ohlcv429DelaysMs.length,
      delay,
    );
    await new Promise((r) => setTimeout(r, delay));
    res = await _fetchOhlcvOnce(url, timeframe);
  }
  if (res.status !== 200 && res.status !== 0) {
    console.warn(
      "[price-fetcher] GeckoTerminal OHLCV %s pool=%s status=%d (treating as empty)",
      timeframe,
      poolAddress,
      res.status,
    );
  }
  return res.close;
}

/**
 * Fetch a historical USD price from GeckoTerminal OHLCV candles with a
 * cascading timeframe fallback: day → hour → minute.
 *
 * Why cascade: for pools that started trading on the same day as the target
 * timestamp (e.g. a meme-token mint on a brand-new pool), the daily candle
 * may not be indexed yet, but hourly/minute candles usually are available
 * since the moment swaps begin. Each finer timeframe is only queried when
 * the coarser one returns 0, so the common case still costs exactly one call.
 *
 * @param {string} poolAddress  V3 pool contract address.
 * @param {number} timestamp    Unix seconds of the target moment.
 * @param {'base'|'quote'} [token='base'] Which pool token to price.
 * @param {string} [network='pulsechain'] GeckoTerminal network identifier.
 * @returns {Promise<number>}  USD close price (0 if unavailable at any tf).
 */
async function _fetchGeckoTerminalOhlcv(
  poolAddress,
  timestamp,
  token = "base",
  network = "pulsechain",
) {
  const attempts = [];
  for (const tf of ["day", "hour", "minute"]) {
    const price = await _fetchGeckoOhlcvAtTimeframe(
      poolAddress,
      timestamp,
      token,
      network,
      tf,
    );
    attempts.push(`${tf}=${price}`);
    if (price > 0) {
      console.log(
        "[price-fetcher] GeckoTerminal OHLCV %s pool=%s ts=%d → $%s via %s",
        token,
        poolAddress,
        timestamp,
        price,
        tf,
      );
      return price;
    }
  }
  console.warn(
    "[price-fetcher] GeckoTerminal OHLCV %s pool=%s ts=%d → ALL EMPTY (%s)",
    token,
    poolAddress,
    timestamp,
    attempts.join(" "),
  );
  return 0;
}

/**
 * Try Moralis historical API for any zero-priced tokens.
 * @returns {{ price0: number, price1: number }}
 */
async function _moralisFallback(p0, p1, t0, t1, blockNumber, network) {
  let price0 = p0,
    price1 = p1;
  if (!blockNumber || (price0 > 0 && price1 > 0)) return { price0, price1 };
  if (price0 === 0 && t0) {
    price0 = await _fetchMoralisHistorical(t0, blockNumber, network);
    if (price0 > 0)
      console.log("[price-fetcher] Moralis historical fallback for token0");
  }
  if (price1 === 0 && t1) {
    price1 = await _fetchMoralisHistorical(t1, blockNumber, network);
    if (price1 > 0)
      console.log("[price-fetcher] Moralis historical fallback for token1");
  }
  return { price0, price1 };
}

/**
 * Fetch historical USD prices for both tokens in a pool from GeckoTerminal.
 * When `token0Address` and `token1Address` are provided, results are cached
 * to disk (via price-cache) keyed by token contract address + UTC date.
 *
 * @param {string} poolAddress  - V3 pool contract address.
 * @param {number} timestamp    - Unix seconds of the target date.
 * @param {string} [network='pulsechain'] - GeckoTerminal network identifier.
 * @param {object} [opts]       - Optional token addresses for disk caching.
 * @param {string} [opts.token0Address] - Token0 contract address.
 * @param {string} [opts.token1Address] - Token1 contract address.
 * @param {number} [opts.blockNumber]   - Block number for Moralis fallback.
 * @returns {Promise<{price0: number, price1: number}>} Historical USD prices.
 */
/**
 * Fetch GeckoTerminal OHLCV with the correct base/quote orientation for the
 * pool. GeckoTerminal's base/quote ordering is NOT guaranteed to match a
 * Uniswap v3 pool's token0/token1 — for some pools they're swapped, which
 * silently produces wildly wrong prices. We resolve the orientation once per
 * pool via the pool-info endpoint and cache the result on disk.
 */
async function _geckoForToken0Token1(poolAddr, ts, network, t0, t1) {
  const orient = await getGeckoPoolOrientation(network, poolAddr, t0, t1);
  flushGeckoPoolCache();
  // Default to "normal" when orientation lookup fails (matches old behavior).
  const flipped = orient === "flipped";
  const p0 = await _fetchGeckoTerminalOhlcv(
    poolAddr,
    ts,
    flipped ? "quote" : "base",
    network,
  );
  const p1 = await _fetchGeckoTerminalOhlcv(
    poolAddr,
    ts,
    flipped ? "base" : "quote",
    network,
  );
  return { p0, p1 };
}

/** Apply Moralis historical for any zero-priced tokens (when key available). */
async function _moralisHistoricalLeg(p0, p1, t0, t1, blockNumber, network) {
  let r0 = p0,
    r1 = p1;
  if (r0 === 0 && t0)
    r0 = await _fetchMoralisHistorical(t0, blockNumber, network);
  if (r1 === 0 && t1)
    r1 = await _fetchMoralisHistorical(t1, blockNumber, network);
  return { p0: r0, p1: r1 };
}

/** Try Moralis first when API key is available, then GeckoTerminal for zeros. */
async function _fetchHistoricalPair(
  poolAddr,
  ts,
  network,
  t0,
  t1,
  c0,
  c1,
  blockNumber,
) {
  const useMoralis = getApiKey("moralis") && blockNumber;
  let p0 = c0 ?? 0,
    p1 = c1 ?? 0;
  if (useMoralis) {
    const m = await _moralisHistoricalLeg(p0, p1, t0, t1, blockNumber, network);
    p0 = m.p0;
    p1 = m.p1;
  }
  const need0 = p0 === 0 && c0 === null;
  const need1 = p1 === 0 && c1 === null;
  if (need0 || need1) {
    const gt = await _geckoForToken0Token1(poolAddr, ts, network, t0, t1);
    if (need0) p0 = gt.p0;
    if (need1) p1 = gt.p1;
  }
  if (!useMoralis)
    return _moralisFallback(p0, p1, t0, t1, blockNumber, network);
  return { price0: p0, price1: p1 };
}

async function fetchHistoricalPriceGecko(
  poolAddress,
  timestamp,
  network = "pulsechain",
  opts = {},
) {
  // Block-scoped key: block numbers are immutable, so no date prefix needed.
  // Date-scoped key: used by epoch P&L callers that don't have a block number.
  const utcKey = opts.blockNumber
    ? `@${opts.blockNumber}`
    : toUtcDayKey(timestamp);
  const t0 = opts.token0Address;
  const t1 = opts.token1Address;
  const c0 = t0 ? getHistoricalPrice(network, t0, utcKey) : null;
  const c1 = t1 ? getHistoricalPrice(network, t1, utcKey) : null;
  if (c0 !== null && c1 !== null) return { price0: c0, price1: c1 };
  const { price0, price1 } = await _fetchHistoricalPair(
    poolAddress,
    timestamp,
    network,
    t0,
    t1,
    c0,
    c1,
    opts.blockNumber,
  );
  // Persist to disk cache
  if (t0 && price0 > 0) setHistoricalPrice(network, t0, utcKey, price0);
  if (t1 && price1 > 0) setHistoricalPrice(network, t1, utcKey, price1);
  if (t0 || t1) flushPriceCache();
  return { price0, price1 };
}

// ── Moralis (current + historical by block) ─────────────────────────────

/** Map GeckoTerminal/internal chain names to Moralis chain identifiers. */
const _MORALIS_CHAINS = { pulsechain: "0x171" };

/**
 * Fetch current USD price from the Moralis Token API.
 * Requires a decrypted Moralis API key in api-key-holder.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} [chain='pulsechain'] - Internal chain name.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchMoralisCurrent(tokenAddress, chain = "pulsechain") {
  const apiKey = getApiKey("moralis");
  if (!apiKey) return 0;
  const chainHex = _MORALIS_CHAINS[chain];
  if (!chainHex) return 0;
  const url =
    `https://deep-index.moralis.io/api/v2.2/erc20` +
    `/${tokenAddress}/price?chain=${chainHex}&include=percent_change`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey },
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const price = Number(json?.usdPrice ?? 0);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch (err) {
    console.warn("[price-fetcher] Moralis current error:", err.message ?? err);
    return 0;
  }
}

/**
 * Fetch a historical USD price from the Moralis Token API by block number.
 * Requires a decrypted Moralis API key in api-key-holder.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {number} blockNumber  - Block number for the historical price.
 * @param {string} [chain='pulsechain'] - Internal chain name.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchMoralisHistorical(
  tokenAddress,
  blockNumber,
  chain = "pulsechain",
) {
  const apiKey = getApiKey("moralis");
  if (!apiKey) return 0;
  const chainHex = _MORALIS_CHAINS[chain];
  if (!chainHex) return 0;
  const url =
    `https://deep-index.moralis.io/api/v2.2/erc20` +
    `/${tokenAddress}/price` +
    `?chain=${chainHex}&to_block=${blockNumber}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey },
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const price = Number(json?.usdPrice ?? 0);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch (err) {
    console.warn(
      "[price-fetcher] Moralis historical error:",
      err.message ?? err,
    );
    return 0;
  }
}

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchTokenPriceUsd,
  fetchHistoricalPriceGecko,
  tryPriceSources,
  _fetchDexScreener,
  _fetchGeckoTerminalOhlcv,
  _fetchGeckoOhlcvAtTimeframe,
  _fetchMoralisCurrent,
  _fetchMoralisHistorical,
  _setOhlcv429Delays,
  _cache,
  _CACHE_TTL_MS,
};
