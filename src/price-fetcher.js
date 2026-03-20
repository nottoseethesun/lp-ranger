/**
 * @file price-fetcher.js
 * @module price-fetcher
 * @description
 * Fetches USD prices for tokens on PulseChain for the 9mm v3 Position Manager.
 *
 * Uses DexScreener (primary, no API key required) and DexTools (fallback,
 * requires an API key) to resolve token prices.  Results are cached in memory
 * with a 60-second TTL to reduce network traffic.
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

'use strict';

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
async function _fetchDexScreener(tokenAddress, chain = 'pulsechain') {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
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
  const chainPairs = pairs.filter(
    (p) => p.chainId === chain,
  );

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

// ── DexTools ─────────────────────────────────────────────────────────────────

/**
 * Fetch USD price for a token from the DexTools API.
 *
 * Requires a valid API key passed via the `apiKey` parameter.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} apiKey       - DexTools API key.
 * @param {string} [chain='pulsechain'] - Chain identifier for the URL path.
 * @returns {Promise<number>} USD price (0 if unavailable or on error).
 */
async function _fetchDexTools(tokenAddress, apiKey, chain = 'pulsechain') {
  const url =
    `https://public-api.dextools.io/free/v2/token/${chain}/${tokenAddress}/price`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    return 0;
  }

  const json = await res.json();
  const price = Number(json?.data?.price ?? json?.data?.priceUsd ?? 0);
  return Number.isFinite(price) ? price : 0;
}

// ── main entry point ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} FetchTokenPriceOpts
 * @property {string}      [chain='pulsechain']  Chain identifier.
 * @property {string|null} [dextoolsApiKey=null] DexTools API key (null to skip fallback).
 */

/**
 * Fetch the current USD price for a token on PulseChain.
 *
 * Resolution order:
 *  1. Return cached value if still within the TTL window.
 *  2. Try DexScreener (no API key required).
 *  3. Try DexTools (only when `dextoolsApiKey` is provided).
 *  4. Return 0 if all sources fail or return no data.
 *
 * All network errors are caught and logged via `console.warn` so that
 * callers never receive a rejected promise.
 *
 * @param {string}              tokenAddress - ERC-20 contract address.
 * @param {FetchTokenPriceOpts} [opts={}]    - Optional configuration.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function fetchTokenPriceUsd(tokenAddress, opts = {}) {
  const chain = opts.chain ?? 'pulsechain';
  const dextoolsApiKey = opts.dextoolsApiKey ?? null;
  const key = _cacheKey(chain, tokenAddress);

  // 1. Cache check.
  const cached = _cache.get(key);
  if (cached && (Date.now() - cached.ts) < _CACHE_TTL_MS) {
    return cached.price;
  }

  // 2. DexScreener (primary).
  try {
    const price = await _fetchDexScreener(tokenAddress, chain);
    if (price > 0) {
      _cache.set(key, { price, ts: Date.now() });
      return price;
    }
  } catch (err) {
    console.warn('[price-fetcher] DexScreener error:', err.message ?? err);
  }

  // 3. DexTools (fallback — only if API key provided).
  if (dextoolsApiKey) {
    try {
      const price = await _fetchDexTools(tokenAddress, dextoolsApiKey, chain);
      if (price > 0) {
        _cache.set(key, { price, ts: Date.now() });
        return price;
      }
    } catch (err) {
      console.warn('[price-fetcher] DexTools error:', err.message ?? err);
    }
  }

  // 4. Nothing worked.
  return 0;
}

// ── GeckoTerminal (historical prices) ────────────────────────────────────────

// ── GeckoTerminal rate limiter (sliding window, 25 calls / 60 s) ─────────────

/** @type {number[]} Timestamps (ms) of recent GeckoTerminal API calls. */
const _geckoCallTimes = [];
const _GECKO_MAX_CALLS = 25;       // leave margin below the 30/min hard limit
const _GECKO_WINDOW_MS = 60_000;

/**
 * Wait if necessary to stay within GeckoTerminal's rate limit.
 * Uses a sliding window: tracks the last N call timestamps and waits
 * until the oldest one falls outside the window before proceeding.
 */
async function _geckoRateLimit() {
  const now = Date.now();
  while (_geckoCallTimes.length > 0 && _geckoCallTimes[0] < now - _GECKO_WINDOW_MS) {
    _geckoCallTimes.shift();
  }
  if (_geckoCallTimes.length >= _GECKO_MAX_CALLS) {
    const waitMs = _geckoCallTimes[0] + _GECKO_WINDOW_MS - now + 200;
    console.log(`[price-fetcher] GeckoTerminal rate limit — waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise(r => setTimeout(r, waitMs));
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
async function _fetchGeckoTerminalOhlcv(poolAddress, timestamp, token = 'base', network = 'pulsechain') {
  await _geckoRateLimit();
  const before = timestamp + 86400;
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}`
    + `/pools/${poolAddress}/ohlcv/day`
    + `?before_timestamp=${before}&limit=1&currency=usd&token=${token}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const candles = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || candles.length === 0) return 0;
    // Candle format: [timestamp, open, high, low, close, volume]
    const close = Number(candles[0][4]);
    return Number.isFinite(close) ? close : 0;
  } catch (err) {
    console.warn('[price-fetcher] GeckoTerminal OHLCV error:', err.message ?? err);
    return 0;
  }
}

/**
 * Fetch historical USD prices for both tokens in a pool from GeckoTerminal.
 *
 * @param {string} poolAddress  - V3 pool contract address.
 * @param {number} timestamp    - Unix seconds of the target date.
 * @param {string} [network='pulsechain'] - GeckoTerminal network identifier.
 * @returns {Promise<{price0: number, price1: number}>} Historical USD prices.
 */
async function fetchHistoricalPriceGecko(poolAddress, timestamp, network = 'pulsechain') {
  const [price0, price1] = await Promise.all([
    _fetchGeckoTerminalOhlcv(poolAddress, timestamp, 'base', network),
    _fetchGeckoTerminalOhlcv(poolAddress, timestamp, 'quote', network),
  ]);
  return { price0, price1 };
}

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchTokenPriceUsd,
  fetchHistoricalPriceGecko,
  _fetchDexScreener,
  _fetchDexTools,
  _fetchGeckoTerminalOhlcv,
  _cache,
  _CACHE_TTL_MS,
};
