/**
 * @file price-fetcher.js
 * @module price-fetcher
 * @description
 * Fetches USD prices for tokens on the active chain for the LP Ranger.
 *
 * Uses three price sources in priority order: Moralis (primary, requires
 * API key, most reliable for meme tokens), GeckoTerminal (free, rate-limited
 * 30/min), and DexScreener (free, but drops tokens with no 24h LP activity).
 * Results are cached in memory for `priceCacheTtlMs` in
 * bot-config-defaults.json (`moveCacheTtlMs` during a rebalance or
 * compound), and each service's base url is in price-services.json.
 *
 * Each service names chains its own way, so the active chain's entry in
 * chains.json gives its id at each (`priceServices`), and "" where a
 * service does not cover the chain; that service is then not asked.
 * Nothing here names a chain. The one lookup off the active chain, the
 * dust-unit reference asset, carries its own ids in dust-threshold.json.
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
 * const price = await fetchTokenPriceUsd(tokenAddress);
 * log.info(`Token price: $${price}`);
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const {
  getHistoricalPrice,
  setHistoricalPrice,
  flushPriceCache,
  toUtcDayKey,
} = require("./price-cache");
/*-
 *  The current-price services and the cascade's order live in
 *  `price-sources-current.js`, split out to hold this file under the
 *  500-line cap.
 */
const {
  currentPriceSources,
  _moralisKey,
  _moralisSource,
  _fetchDexScreener,
  _fetchMoralisCurrent,
} = require("./price-sources-current");
const { geckoRateLimit } = require("./gecko-rate-limit");
const { retryOn429 } = require("./price-source-backoff");
const {
  getGeckoPoolOrientation,
  flushGeckoPoolCache,
} = require("./gecko-pool-cache");
const {
  tryPriceSources,
  formatToken: _formatToken,
} = require("./price-source-cascade");
const {
  pausePriceLookups,
  unpausePriceLookups,
  isPaused,
  inMove,
  withFreshPricesAllowed,
  getPriceCacheTtlMs,
  getDustUnitPriceCacheTtlMs,
  getMoveCacheTtlMs,
  _resetPauseStateForTests,
} = require("./price-fetcher-gate");
const {
  getInflight,
  trackInflight,
  logCacheHit,
  logPausedCached,
  logDustCacheHit,
  logDustPausedCached,
} = require("./price-fetcher-dedup");
const { GECKO_TERMINAL_API, MORALIS_API } = require("./price-service-urls");
const { cacheKey } = require("./cache-store");

// ── constants ────────────────────────────────────────────────────────────────

/**
 * In-memory price cache.
 * Keys are the canonical `chain-token` (`cacheKey` in `src/cache-store.js`).
 * Values are `{ price: number, ts: number }`.
 * @type {Map<string, { price: number, ts: number }>}
 */
const _cache = new Map();

// ── price source chain ──────────────────────────────────────────────────────

// `tryPriceSources` and `_formatToken` live in `price-source-cascade.js`
// (extracted to keep this file under the 500-line cap).

// ── main entry point ─────────────────────────────────────────────────────────

/**
 * Fetch the current USD price for a token on the active chain.
 *
 * Resolution order:
 *  1. Return cached value if still within the TTL window.
 *  2. Try Moralis (requires API key — most reliable for meme tokens).
 *  3. Try GeckoTerminal (free, no API key, rate-limited 30/min).
 *  4. Try DexScreener (free, no API key — drops tokens with no 24h activity).
 *  5. Return 0 if all sources fail or return no data.
 *
 * A service the chain's entry gives no id for is skipped. All network
 * errors are caught and logged via `console.warn` so that callers never
 * receive a rejected promise.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function fetchTokenPriceUsd(tokenAddress) {
  const chain = config.CHAIN_NAME;
  const key = cacheKey(chain, tokenAddress);
  const cached = _cache.get(key);
  /*- Idle gate: when paused AND not inside a `withFreshPricesAllowed`
   *  scope, return the last known cached value (or 0 on cold start) and
   *  never invoke the cascade.  See docs/architecture.md "Idle-Driven
   *  Price-Lookup Pause". */
  if (!inMove() && isPaused()) {
    logPausedCached(tokenAddress, cached);
    return cached ? cached.price : 0;
  }
  /*-
   *  Freshness window: 120 s outside a move (steady-state polling) vs
   *  4 s inside a move (rebalance/compound pipeline), as shipped
   *  (`priceCacheTtlMs`, `moveCacheTtlMs`, as src/price-fetcher-gate.js
   *  read them). The shorter in-move TTL collapses the rapid-fire burst
   *  that the same pipeline triggers when multiple stages each call
   *  fetchTokenPriceUsd for the same token within seconds, while still
   *  re-fetching often enough that a move-relevant on-chain price change
   *  shows up promptly. It replaced bypassing the cache inside a move,
   *  which sent four to six requests per token per move.
   */
  const ttl = inMove() ? getMoveCacheTtlMs() : getPriceCacheTtlMs();
  if (cached && Date.now() - cached.ts < ttl) {
    logCacheHit(tokenAddress, cached);
    return cached.price;
  }

  /*- In-flight dedup: if another caller already kicked off a fetch for
   *  the same key, await its promise instead of starting a parallel
   *  cascade.  Active in every scope — move scopes still get the
   *  freshest *post-move-start* price within the in-move TTL window
   *  above.  See src/price-fetcher-dedup.js. */
  const pending = getInflight(key, tokenAddress);
  if (pending) return pending;

  const services = config.CHAIN.priceServices;
  const sources = currentPriceSources(tokenAddress, services);
  /*-
   *  A chain no price service covers has no source to ask, so there is
   *  no price and nothing failed: the cascade would still log "All
   *  sources failed" for every token on every poll.
   */
  if (sources.length === 0) return 0;
  const fetchPromise = tryPriceSources(sources, {
    token: tokenAddress,
    chain,
  }).then((price) => {
    if (price > 0) _cache.set(key, { price, ts: Date.now() });
    return price;
  });

  return trackInflight(key, fetchPromise);
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
    log.warn(
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
  // End of the UTC day the timestamp falls in. `limit=1` returns the
  // most recent candle whose close time is ≤ `before_timestamp`.
  const dayStart = Math.floor(timestamp / 86400) * 86400;
  const before = dayStart + 86400;
  const url =
    `${GECKO_TERMINAL_API}/networks/${network}` +
    `/pools/${poolAddress}/ohlcv/${timeframe}` +
    `?before_timestamp=${before}&limit=1&currency=usd&token=${token}`;
  /*- GeckoTerminal enforces its own limit on top of our in-process one,
   *  which tracks our intent rather than their counter, so a burst can
   *  trip them while the limiter still says OK. A 429 means "retry
   *  later", distinct from "no data".
   *
   *  The retry AND the cross-call escalation both live in
   *  `price-source-backoff.js` — the other GeckoTerminal caller raises
   *  the same penalty, and neither module owns the other. */
  const res = await retryOn429({
    source: "gecko",
    label: `OHLCV ${timeframe} pool=${poolAddress}`,
    /*- The limiter goes INSIDE, so every attempt consults it — a retry
     *  is a request like any other and must take a slot in the window
     *  and honour the cool-down. Outside, a call that retried three
     *  times made four requests and recorded one, and its retries were
     *  the only Gecko traffic in the process that ignored the penalty. */
    fetchOnce: async () => {
      await geckoRateLimit();
      return _fetchOhlcvOnce(url, timeframe);
    },
  });
  if (res.status !== 200 && res.status !== 0) {
    log.warn(
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
 * @param {'base'|'quote'} token Which pool token to price.
 * @param {string} network      GeckoTerminal's id for the pool's chain.
 * @returns {Promise<number>}  USD close price (0 if unavailable at any tf).
 */
async function _fetchGeckoTerminalOhlcv(
  poolAddress,
  timestamp,
  token,
  network,
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
      log.info(
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
  log.warn(
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
async function _moralisFallback(p0, p1, t0, t1, blockNumber, moralisChain) {
  let price0 = p0,
    price1 = p1;
  if (!blockNumber || (price0 > 0 && price1 > 0)) return { price0, price1 };
  if (price0 === 0 && t0) {
    price0 = await _fetchMoralisHistorical(t0, blockNumber, moralisChain);
    if (price0 > 0)
      log.info(
        "[price-fetcher] Moralis historical fallback for token0=%s",
        _formatToken(t0),
      );
  }
  if (price1 === 0 && t1) {
    price1 = await _fetchMoralisHistorical(t1, blockNumber, moralisChain);
    if (price1 > 0)
      log.info(
        "[price-fetcher] Moralis historical fallback for token1=%s",
        _formatToken(t1),
      );
  }
  return { price0, price1 };
}

/**
 * Fetch GeckoTerminal OHLCV with the correct base/quote orientation for the
 * pool. GeckoTerminal's base/quote ordering is NOT guaranteed to match a
 * Uniswap v3 pool's token0/token1 — for some pools they're swapped, which
 * silently produces wildly wrong prices. We resolve the orientation once per
 * pool via the pool-info endpoint and cache the result on disk.
 *
 * When the orientation cannot be learned — the lookup was refused, timed
 * out, or named a base token that is neither of the pool's — no price is
 * taken from GeckoTerminal at all. Guessing would be right for most pools
 * and would swap the two prices for the rest, and a historical price is
 * cached with no expiry, so a wrong one would stand until Re-scan Prices.
 * Zeros are not cached, so a later read asks again.
 */
async function _geckoForToken0Token1(poolAddr, ts, network, t0, t1) {
  const orient = await getGeckoPoolOrientation(network, poolAddr, t0, t1);
  flushGeckoPoolCache();
  if (orient === null) {
    log.warn(
      "[price-fetcher] GeckoTerminal orientation unknown for pool %s — no historical price from it this time",
      poolAddr,
    );
    return { p0: 0, p1: 0 };
  }
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
async function _moralisHistoricalLeg(
  p0,
  p1,
  t0,
  t1,
  blockNumber,
  moralisChain,
) {
  let r0 = p0,
    r1 = p1;
  if (r0 === 0 && t0)
    r0 = await _fetchMoralisHistorical(t0, blockNumber, moralisChain);
  if (r1 === 0 && t1)
    r1 = await _fetchMoralisHistorical(t1, blockNumber, moralisChain);
  return { p0: r0, p1: r1 };
}

/**
 * Try Moralis first when API key is available, then GeckoTerminal for
 * zeros. A service the chain's entry gives no id for is not asked.
 */
async function _fetchHistoricalPair(
  poolAddr,
  ts,
  services,
  t0,
  t1,
  c0,
  c1,
  blockNumber,
) {
  const { moralisChain, geckoTerminalNetwork } = services;
  const useMoralis = _moralisKey() && blockNumber;
  let p0 = c0 ?? 0,
    p1 = c1 ?? 0;
  if (useMoralis) {
    const m = await _moralisHistoricalLeg(
      p0,
      p1,
      t0,
      t1,
      blockNumber,
      moralisChain,
    );
    p0 = m.p0;
    p1 = m.p1;
  }
  const need0 = p0 === 0 && c0 === null;
  const need1 = p1 === 0 && c1 === null;
  if ((need0 || need1) && geckoTerminalNetwork !== "") {
    const gt = await _geckoForToken0Token1(
      poolAddr,
      ts,
      geckoTerminalNetwork,
      t0,
      t1,
    );
    if (need0) p0 = gt.p0;
    if (need1) p1 = gt.p1;
  }
  if (!useMoralis)
    return _moralisFallback(p0, p1, t0, t1, blockNumber, moralisChain);
  return { price0: p0, price1: p1 };
}

/**
 * Fetch historical USD prices for both tokens in a pool on the active
 * chain. When `token0Address` and `token1Address` are provided, results are
 * cached to disk (via price-cache) under the chain, keyed by token contract
 * address + UTC date.
 *
 * @param {string} poolAddress  - V3 pool contract address.
 * @param {number} timestamp    - Unix seconds of the target date.
 * @param {object} [opts]       - Optional token addresses for disk caching.
 * @param {string} [opts.token0Address] - Token0 contract address.
 * @param {string} [opts.token1Address] - Token1 contract address.
 * @param {number} [opts.blockNumber]   - Block number for Moralis fallback.
 * @param {boolean} [opts.refresh]      - Fetch even when the price is cached,
 *   and overwrite the cached entry with what comes back.
 * @returns {Promise<{price0: number, price1: number}>} Historical USD prices.
 */
async function fetchHistoricalPriceGecko(poolAddress, timestamp, opts = {}) {
  const chain = config.CHAIN_NAME;
  // Block-scoped key: block numbers are immutable, so no date prefix needed.
  // Date-scoped key: used by epoch P&L callers that don't have a block number.
  const utcKey = opts.blockNumber
    ? `@${opts.blockNumber}`
    : toUtcDayKey(timestamp);
  const t0 = opts.token0Address;
  const t1 = opts.token1Address;
  /*- `refresh` is the Re-scan Prices path. A historical price never
   *  changes, so the disk cache has no expiry — which also means a bad
   *  entry stays until something reads past it. Reading past it is the
   *  only way a re-value reaches a new number; whatever comes back is
   *  written over the old entry below. */
  const useCache = opts.refresh !== true;
  const c0 = t0 && useCache ? getHistoricalPrice(chain, t0, utcKey) : null;
  const c1 = t1 && useCache ? getHistoricalPrice(chain, t1, utcKey) : null;
  if (c0 !== null && c1 !== null) return { price0: c0, price1: c1 };
  const services = config.CHAIN.priceServices;
  const { price0, price1 } = await _fetchHistoricalPair(
    poolAddress,
    timestamp,
    services,
    t0,
    t1,
    c0,
    c1,
    opts.blockNumber,
  );
  // Persist to disk cache
  if (t0 && price0 > 0) setHistoricalPrice(chain, t0, utcKey, price0);
  if (t1 && price1 > 0) setHistoricalPrice(chain, t1, utcKey, price1);
  if (t0 || t1) flushPriceCache();
  return { price0, price1 };
}

// ── Moralis (historical by block) ───────────────────────────────────────

/**
 * Fetch a historical USD price from the Moralis Token API by block number.
 * Requires a decrypted Moralis API key in api-key-holder.
 *
 * @param {string} tokenAddress - ERC-20 contract address.
 * @param {number} blockNumber  - Block number for the historical price.
 * @param {string} chain - Moralis's hex id for the token's chain; "" for a
 *   chain Moralis does not cover, which answers 0 without asking.
 * @returns {Promise<number>} USD price (0 if unavailable).
 */
async function _fetchMoralisHistorical(tokenAddress, blockNumber, chain) {
  const apiKey = _moralisKey();
  if (!apiKey) return 0;
  if (!chain) return 0;
  const url =
    `${MORALIS_API}/erc20` +
    `/${tokenAddress}/price` +
    `?chain=${chain}&to_block=${blockNumber}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey },
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const price = Number(json?.usdPrice ?? 0);
    if (Number.isFinite(price) && price > 0) {
      log.info(
        "[price-fetcher] Moralis historical hit token=%s block=%s price=$%s",
        _formatToken(tokenAddress),
        blockNumber,
        price.toFixed(6),
      );
      return price;
    }
    return 0;
  } catch (err) {
    log.warn(
      "[price-fetcher] Moralis historical error token=%s block=%s — %s",
      _formatToken(tokenAddress),
      blockNumber,
      err.message ?? err,
    );
    return 0;
  }
}

// ── Dust-unit price (inflation-resistant reference asset) ──────────────────

const { loadMergedDefaults } = require("./load-merged-defaults");

let _dustUnitPriceCache = null; // { price, ts }

/**
 * Filename of the dust-threshold config, which carries both the
 * threshold value and the list of price-source tokens used to derive
 * the live USD-per-unit value.  Loaded via the layered defaults+user-
 * override loader (see `src/load-merged-defaults.js`); operators
 * override at `app-config/user-configurable/dust-threshold.json`.
 */
const _DUST_THRESHOLD_FILENAME = "dust-threshold.json";

/**
 * Load and validate the price-source token list from disk.  Returns [] on
 * any error so callers get a clean "no sources" result rather than a crash.
 */
function _loadDustPriceSources() {
  try {
    const json = loadMergedDefaults(_DUST_THRESHOLD_FILENAME);
    if (!Array.isArray(json?.priceSourceTokens)) return [];
    return json.priceSourceTokens.filter(
      (t) => t && t.address && t.moralisChain && t.dexScreenerChain,
    );
  } catch (err) {
    log.warn(
      "[price-fetcher] Could not load %s: %s",
      _DUST_THRESHOLD_FILENAME,
      err.message ?? err,
    );
    return [];
  }
}

/**
 * Fetch the current USD price of one unit of the dust reference asset.
 *
 * Iterates through `priceSourceTokens` in `dust-threshold.json` (array order:
 * first is alpha, rest are fallbacks).  Each token is tried via Moralis
 * first, then DexScreener; first non-zero result wins.  The abstraction is
 * deliberately generic — the reference asset's identity (currently gold,
 * via PAXG/XAUT) lives in the JSON, not in this code.
 *
 * Result cached for 1 hour.  Returns 0 if all sources fail.
 *
 * @returns {Promise<number>} USD per reference-asset unit.
 */
async function fetchDustUnitPriceUsd() {
  /*- Same idle-pause gate as `fetchTokenPriceUsd`.  When paused outside
   *  a move scope, return the last cached value (or 0 on cold start)
   *  without touching any source. */
  if (!inMove() && isPaused()) {
    logDustPausedCached(_dustUnitPriceCache);
    return _dustUnitPriceCache ? _dustUnitPriceCache.price : 0;
  }
  /*-
   *  Mirrors fetchTokenPriceUsd. Outside a move, the dust-unit price's
   *  long TTL, since reference-asset prices (e.g. gold) move slowly:
   *  `priceCacheTtlMs * dustUnitPriceCacheMultiplier`, an hour as
   *  shipped. Inside one, the shorter in-move TTL.
   */
  const ttl = inMove() ? getMoveCacheTtlMs() : getDustUnitPriceCacheTtlMs();
  if (_dustUnitPriceCache && Date.now() - _dustUnitPriceCache.ts < ttl) {
    logDustCacheHit(_dustUnitPriceCache);
    return _dustUnitPriceCache.price;
  }
  const tokens = _loadDustPriceSources();
  for (const tok of tokens) {
    const moralis = _moralisSource(() =>
      _fetchMoralisCurrent(tok.address, tok.moralisChain),
    );
    const sources = [
      ...moralis,
      {
        name: "DexScreener",
        fn: () => _fetchDexScreener(tok.address, tok.dexScreenerChain),
      },
    ];
    const price = await tryPriceSources(sources, {
      token: tok.address,
      symbol: tok.symbol,
      chain: tok.dexScreenerChain,
    });
    if (price > 0) {
      const cachedMin = getDustUnitPriceCacheTtlMs() / 60000;
      log.info(
        "[dust-unit-price] %s = $%s / unit (cached %d min)",
        tok.symbol,
        price.toFixed(2),
        cachedMin,
      );
      _dustUnitPriceCache = { price, ts: Date.now() };
      return price;
    }
  }
  log.warn("[dust-unit-price] All sources failed — returning 0");
  return 0;
}

/** Reset the in-memory dust-unit-price cache (for tests). */
function _resetDustUnitPriceCache() {
  _dustUnitPriceCache = null;
}

/**
 * Drop in-memory price-cache entries for the given tokens so the next
 * fetch hits the cascade.  Used by move paths (auto/manual rebalance,
 * auto/manual compound) right before `withFreshPricesAllowed` so the
 * move executes against on-chain-fresh prices even if the cache is warm.
 * The tokens are the active chain's, as every cached price is.
 *
 * @param {Array<{token: string}>} tokens
 */
function invalidatePriceCacheFor(tokens) {
  if (!Array.isArray(tokens)) return;
  for (const t of tokens) {
    if (!t || !t.token) continue;
    _cache.delete(cacheKey(config.CHAIN_NAME, t.token));
  }
}

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchTokenPriceUsd,
  fetchHistoricalPriceGecko,
  fetchDustUnitPriceUsd,
  tryPriceSources,
  // Idle-driven pause API (re-exported from price-fetcher-gate for
  // callers that already require('./price-fetcher')).
  pausePriceLookups,
  unpausePriceLookups,
  withFreshPricesAllowed,
  invalidatePriceCacheFor,
  _fetchGeckoTerminalOhlcv,
  _fetchGeckoOhlcvAtTimeframe,
  _fetchMoralisHistorical,
  _resetDustUnitPriceCache,
  _resetPauseStateForTests,
  _cache,
};
