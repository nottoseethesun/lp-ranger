/**
 * @file src/price-sources-current.js
 * @module priceSourcesCurrent
 * @description
 * The services that answer a token's CURRENT USD price — Moralis,
 * GeckoTerminal and DexScreener — and the order the price cascade asks
 * them in, `currentPriceSources`. Split out of `price-fetcher.js`, which
 * keeps the cache, the cascade's entry point and the historical lookups,
 * to hold that file under the 500-line cap.
 *
 * Each fetcher takes the service's own id for the token's chain, because
 * each service names chains its own way. For the active chain those ids
 * come from its chains.json entry (`priceServices`), where "" means the
 * service does not cover the chain.
 */

"use strict";

const { log } = require("./log");
const { getApiKey, isServiceEnabled } = require("./api-key-holder");
const { geckoRateLimit } = require("./gecko-rate-limit");
const { formatToken: _formatToken } = require("./price-source-cascade");
const {
  DEXSCREENER_API,
  GECKO_TERMINAL_API,
  MORALIS_API,
} = require("./price-service-urls");

/**
 * The Moralis key, but only when the operator has left Moralis on.
 *
 * One gate rather than an `&& enabled` at each of the call sites — the
 * question "may we call Moralis?" has exactly one answer, and several
 * copies of it are several chances for them to drift.
 *
 * Returns null when the key is absent OR the operator has switched it
 * off, which is precisely when the caller should fall through to
 * GeckoTerminal.
 * @returns {string|null}
 */
function _moralisKey() {
  if (!isServiceEnabled("moralis")) return null;
  return getApiKey("moralis");
}

/**
 * Moralis as a price-source entry, or nothing at all when it is not
 * usable.
 *
 * Returns an empty list rather than a source that returns 0, because
 * the cascade logs a zero as "Moralis miss — no data". That reads as
 * "Moralis was asked and had nothing", which is indistinguishable from
 * a real miss and left an operator who had just switched Moralis off
 * watching lines that said it was still being consulted. A source that
 * is not in the list produces no line, which is the truth.
 *
 * @param {Function} fn  The fetcher to run when Moralis IS usable.
 * @returns {Array<{name: string, fn: Function}>}  One entry, or none.
 */
function _moralisSource(fn) {
  return _moralisKey() ? [{ name: "Moralis", fn }] : [];
}

// ── DexScreener ──────────────────────────────────────────────────────────────

/**
 * Fetch USD price for a token from the DexScreener API.
 *
 * Filters the returned pairs to those on the requested chain and selects the
 * pair with the highest USD liquidity.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} chain - DexScreener's id for the token's chain, which
 *   the pairs are filtered to.
 * @returns {Promise<number>} USD price (0 if unavailable or on error).
 */
async function _fetchDexScreener(tokenAddress, chain) {
  const url = `${DEXSCREENER_API}/latest/dex/tokens/${tokenAddress}`;

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
 * @param {string} network - GeckoTerminal's id for the token's chain.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchGeckoTerminalCurrent(tokenAddress, network) {
  await geckoRateLimit();
  const url =
    `${GECKO_TERMINAL_API}/simple/networks/${network}` +
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

// ── Moralis (current price) ──────────────────────────────────────────────────

/**
 * Fetch current USD price from the Moralis Token API.
 * Requires a decrypted Moralis API key in api-key-holder.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {string} chain - Moralis's hex id for the token's chain; "" for a
 *   chain Moralis does not cover, which answers 0 without asking.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchMoralisCurrent(tokenAddress, chain) {
  const apiKey = _moralisKey();
  if (!apiKey) return 0;
  if (!chain) return 0;
  const url =
    `${MORALIS_API}/erc20` +
    `/${tokenAddress}/price?chain=${chain}&include=percent_change`;
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
    log.warn(
      "[price-fetcher] Moralis current error token=%s chain=%s — %s",
      _formatToken(tokenAddress),
      chain,
      err.message ?? err,
    );
    return 0;
  }
}

// ── the cascade's order ──────────────────────────────────────────────────────

/**
 * The sources for a token's current price, in the app's order, leaving out
 * any service the chain's entry says does not cover it. Left out rather
 * than asked and answered with 0, which the cascade would log as a miss —
 * as it would a service that had been asked.
 *
 * @param {string} tokenAddress  ERC-20 contract address.
 * @param {{dexScreenerChain: string, geckoTerminalNetwork: string,
 *   moralisChain: string}} services  The chain's `priceServices`.
 * @returns {Array<{name: string, fn: Function}>}
 */
function currentPriceSources(tokenAddress, services) {
  const sources = [];
  if (services.moralisChain !== "") {
    const moralis = _moralisSource(() =>
      _fetchMoralisCurrent(tokenAddress, services.moralisChain),
    );
    sources.push(...moralis);
  }
  if (services.geckoTerminalNetwork !== "")
    sources.push({
      name: "GeckoTerminal",
      fn: () =>
        _fetchGeckoTerminalCurrent(tokenAddress, services.geckoTerminalNetwork),
    });
  if (services.dexScreenerChain !== "")
    sources.push({
      name: "DexScreener",
      fn: () => _fetchDexScreener(tokenAddress, services.dexScreenerChain),
    });
  return sources;
}

module.exports = {
  currentPriceSources,
  _moralisKey,
  _moralisSource,
  _fetchDexScreener,
  _fetchGeckoTerminalCurrent,
  _fetchMoralisCurrent,
};
