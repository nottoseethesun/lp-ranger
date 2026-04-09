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
 * sliding-window rate limiter (`_geckoRateLimit()`) is applied inside
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
  await _geckoRateLimit();
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

// ── GeckoTerminal rate limiter (sliding window, 25 calls / 60 s) ─────────────

/** @type {number[]} Timestamps (ms) of recent GeckoTerminal API calls. */
const _geckoCallTimes = [];
const _GECKO_MAX_CALLS = 25; // leave margin below the 30/min hard limit
const _GECKO_WINDOW_MS = 60_000;

/**
 * Wait if necessary to stay within GeckoTerminal's rate limit.
 * Uses a sliding window: tracks the last N call timestamps and waits
 * until the oldest one falls outside the window before proceeding.
 */
async function _geckoRateLimit() {
  const now = Date.now();
  while (
    _geckoCallTimes.length > 0 &&
    _geckoCallTimes[0] < now - _GECKO_WINDOW_MS
  ) {
    _geckoCallTimes.shift();
  }
  if (_geckoCallTimes.length >= _GECKO_MAX_CALLS) {
    const waitMs = _geckoCallTimes[0] + _GECKO_WINDOW_MS - now + 200;
    console.log(
      `[price-fetcher] GeckoTerminal rate limit — waiting ${Math.ceil(waitMs / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  _geckoCallTimes.push(Date.now());
}

/**
 * Fetch a historical USD price from GeckoTerminal OHLCV candles.
 *
 * Queries the free GeckoTerminal API for daily candle data at the given
 * timestamp.  Returns the close price of the nearest candle, or 0 on failure.
 *
 * @param {string} poolAddress  - V3 pool contract address.
 * @param {number} timestamp    - Unix seconds of the target date.
 * @param {'base'|'quote'} [token='base'] - Which pool token to price.
 * @param {string} [network='pulsechain'] - GeckoTerminal network identifier.
 * @returns {Promise<number>} USD close price (0 if unavailable).
 */
async function _fetchGeckoTerminalOhlcv(
  poolAddress,
  timestamp,
  token = "base",
  network = "pulsechain",
) {
  await _geckoRateLimit();
  const before = timestamp + 86400;
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}` +
    `/pools/${poolAddress}/ohlcv/day` +
    `?before_timestamp=${before}&limit=1&currency=usd&token=${token}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const candles = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || candles.length === 0) return 0;
    // Candle format: [timestamp, open, high, low, close, volume]
    const close = Number(candles[0][4]);
    return Number.isFinite(close) ? close : 0;
  } catch (err) {
    console.warn(
      "[price-fetcher] GeckoTerminal OHLCV error:",
      err.message ?? err,
    );
    return 0;
  }
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
    if (p0 === 0 && t0)
      p0 = await _fetchMoralisHistorical(t0, blockNumber, network);
    if (p1 === 0 && t1)
      p1 = await _fetchMoralisHistorical(t1, blockNumber, network);
  }
  if (p0 === 0 && c0 === null)
    p0 = await _fetchGeckoTerminalOhlcv(poolAddr, ts, "base", network);
  if (p1 === 0 && c1 === null)
    p1 = await _fetchGeckoTerminalOhlcv(poolAddr, ts, "quote", network);
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
  // When a block number is provided, scope the disk cache key to the block
  // so different blocks don't collide (deposits at different blocks need
  // different historical prices, even if fetched on the same calendar day).
  const baseKey = toUtcDayKey(timestamp);
  const utcKey = opts.blockNumber ? `${baseKey}@${opts.blockNumber}` : baseKey;
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
  _fetchMoralisCurrent,
  _fetchMoralisHistorical,
  _cache,
  _CACHE_TTL_MS,
};
