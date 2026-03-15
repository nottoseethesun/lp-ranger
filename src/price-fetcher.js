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

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchTokenPriceUsd,
  _fetchDexScreener,
  _fetchDexTools,
  _cache,
  _CACHE_TTL_MS,
};
