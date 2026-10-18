/**
 * @file cache-store.js
 * @module cache-store
 * @description
 * Simple JSON file-based cache for expensive-to-fetch data.  Each cache entry
 * has a key, a value (any JSON-serialisable object), and a TTL.  The cache is
 * loaded lazily on first access and persisted to disk on every write.
 *
 * Used by the event scanner (rebalance history) and P&L tracker (daily P&L
 * snapshots) to avoid re-fetching thousands of on-chain records every load.
 *
 * The app remains stateless from a correctness standpoint — the cache is a
 * pure performance optimisation.  If the cache file is deleted, everything is
 * rebuilt from the blockchain.
 *
 * @example
 * const cache = createCacheStore({ filePath: './cache/events.json', defaultTtlMs: 3600000 });
 * await cache.set('rebalance:0xABC', events, 86400000);
 * const hit = await cache.get('rebalance:0xABC');
 */

"use strict";

const { log } = require("./log");
const { loadMergedDefaults } = require("./load-merged-defaults");
const fs = require("fs");
const path = require("path");

/**
 * @typedef {Object} CacheEntry
 * @property {*}      value     - Cached value (must be JSON-serialisable).
 * @property {number} expiresAt - Unix ms when this entry expires.
 */

/**
 * @typedef {Object} CacheStore
 * @property {function(string): Promise<*|null>}          get    - Retrieve a cached value by key.
 * @property {function(string, *, number=): Promise<void>} set    - Store a value with optional TTL override.
 * @property {function(string): Promise<boolean>}         delete - Remove a single entry.
 * @property {function(): Promise<void>}                  clear  - Remove all entries.
 * @property {function(): number}                         size   - Number of entries (including expired).
 */

/**
 * Create a file-backed cache store.
 *
 * The TTL has no default here. Each cache's lifetime is a setting of its
 * own, read by the caller from the JSON configuration, and a figure
 * supplied here instead would be a second value for it that nothing
 * configures.
 *
 * @param {Object} opts
 * @param {string} opts.filePath      - Path to the JSON cache file.
 * @param {number} opts.defaultTtlMs  - TTL in ms for a `set` that names none.
 * @param {Object} [opts.fsModule]    - Injected fs module (for testing).
 * @returns {CacheStore}
 */
function createCacheStore(opts) {
  const { filePath, defaultTtlMs, fsModule = fs } = opts;

  /** @type {Map<string, CacheEntry>|null} */
  let store = null;

  /**
   * Load the cache from disk into memory. Creates the directory if needed.
   * Silently starts with an empty Map on any error.
   */
  function _load() {
    if (store !== null) return;
    try {
      const raw = fsModule.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      store = new Map(Object.entries(parsed));
    } catch (_) {
      store = new Map();
    }
  }

  /**
   * Persist the in-memory Map to disk as JSON.
   * Creates parent directories as needed.
   */
  function _save() {
    const obj = Object.fromEntries(store);
    const dir = path.dirname(filePath);
    try {
      fsModule.mkdirSync(dir, { recursive: true });
      fsModule.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      log.warn("[cache-store] Failed to persist cache:", err.message);
    }
  }

  /**
   * Retrieve a cached value. Returns null if missing or expired.
   * @param {string} key
   * @returns {Promise<*|null>}
   */
  async function get(key) {
    _load();
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      _save();
      return null;
    }
    return entry.value;
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {*}      value   - Must be JSON-serialisable.
   * @param {number} [ttlMs] - TTL in ms. Defaults to opts.defaultTtlMs.
   * @returns {Promise<void>}
   */
  async function set(key, value, ttlMs) {
    _load();
    const ttl = ttlMs ?? defaultTtlMs;
    store.set(key, { value, expiresAt: Date.now() + ttl });
    _save();
  }

  /**
   * Delete a single cache entry.
   * @param {string} key
   * @returns {Promise<boolean>} True if the entry existed.
   */
  async function del(key) {
    _load();
    const had = store.delete(key);
    if (had) _save();
    return had;
  }

  /**
   * Remove all entries.
   * @returns {Promise<void>}
   */
  async function clear() {
    _load();
    store.clear();
    _save();
  }

  /**
   * Return the number of entries (including expired ones not yet pruned).
   * @returns {number}
   */
  function size() {
    _load();
    return store.size;
  }

  return { get, set, delete: del, clear, size };
}

/**
 * The tag that names a chain in cache file names and cache keys: its
 * `cacheTag` in chains.json.
 *
 * Each chain declares its own, so two chains never share a cache file;
 * PulseChain's is `pulse`, the tag its existing caches already carry. A
 * tag is lower-case letters and digits only, because the keys it heads
 * are joined with dashes and a chain's own name may contain one. There is
 * no fallback: a chain without a usable tag of its own throws, naming the
 * setting.
 *
 * @param {string} chainName  The chain's key in chains.json.
 * @returns {string} The chain's cache tag.
 * @throws {Error} When the chain gives no usable tag, or shares its tag
 *   with another chain.
 */
function chainCacheTag(chainName) {
  const chains = loadMergedDefaults("chains.json");
  const tag = chains[chainName]?.cacheTag;
  if (typeof tag !== "string" || !/^[a-z0-9]+$/.test(tag)) {
    throw new Error(
      `chains.json → ${chainName}.cacheTag must be lower-case letters and ` +
        `digits; it is ${JSON.stringify(tag)}.`,
    );
  }
  const sharing = Object.keys(chains).filter(
    (other) => other !== chainName && chains[other]?.cacheTag === tag,
  );
  if (sharing.length > 0) {
    throw new Error(
      `chains.json → ${chainName}.cacheTag "${tag}" is also the tag of ` +
        `${sharing.join(", ")}; two chains with one tag share their caches.`,
    );
  }
  return tag;
}

/**
 * The canonical key of an entry in a cache of chain data: the chain
 * first, then whatever identifies the entry, joined with dashes, every
 * part lower-cased so an address matches in either capitalisation.
 *
 * The chain is its key in chains.json, the name the historical-price,
 * block-time and epoch caches already lead with. Leading with it keeps
 * one chain's entries from answering for another's: a token or a pool
 * can sit at the same address on two chains, and PulseChain's copy of
 * Ethereum's state means many do.
 *
 * @param {string} chain  The chain's key in chains.json.
 * @param {...(string|number|bigint)} parts  What identifies the entry.
 * @returns {string}
 */
function cacheKey(chain, ...parts) {
  return [chain, ...parts].map((p) => String(p).toLowerCase()).join("-");
}

/**
 * Build the canonical "liquidity-pair scope" key string used as the suffix of
 * `event-cache-*.json` filenames and as the top-level key of
 * `liquidity-pair-details-cache.json`.
 *
 * Format: `{cacheTag}-{factory:6hex}-{wallet:6hex}-{t0:8hex}-{t1:8hex}-{fee}`
 * where the chain is its `chainCacheTag` and all hex segments are
 * lower-case and skip the `0x` prefix.  The same string identifies an
 * asset configuration (chain + NFT factory + wallet + token pair + fee
 * tier) regardless of which specific pool address holds it at any given
 * time — the load-bearing property for Lifetime P&L reporting across
 * pool-instance redeployments.
 *
 * @param {object} args
 * @param {string} args.blockchain   The chain's key in chains.json.
 * @param {string} args.factory      NFT factory / position manager address.
 * @param {string} args.wallet       Owner wallet address.
 * @param {string} args.token0       Pool token0 address.
 * @param {string} args.token1       Pool token1 address.
 * @param {number|string} args.fee   Pool fee tier.
 * @returns {string} Dash-joined scope key.
 */
function liquidityPairScopeKey({
  blockchain,
  factory,
  wallet,
  token0,
  token1,
  fee,
}) {
  const bc = chainCacheTag(blockchain);
  const pm = (factory || "").slice(2, 8).toLowerCase();
  const w = (wallet || "").slice(2, 8).toLowerCase();
  const t0 = (token0 || "").slice(2, 10).toLowerCase();
  const t1 = (token1 || "").slice(2, 10).toLowerCase();
  return `${bc}-${pm}-${w}-${t0}-${t1}-${fee}`;
}

/**
 * Build a deterministic cache file path for event scanning, keyed by
 * blockchain + contract + pool identity.  Filename suffix matches
 * {@link liquidityPairScopeKey}.
 *
 * @param {{ token0: string, token1: string, fee: number|string }} position
 * @param {string} blockchain    The chain's key in chains.json.
 * @param {string} [contract]    NFT factory / position manager address.
 * @param {string} [wallet]      Owner wallet address.
 * @returns {string} Absolute path under tmp/
 */
function eventCachePath(position, blockchain, contract, wallet) {
  const scope = liquidityPairScopeKey({
    blockchain,
    factory: contract,
    wallet,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  });
  return path.join(process.cwd(), "tmp", `event-cache-${scope}.json`);
}

module.exports = {
  createCacheStore,
  cacheKey,
  eventCachePath,
  liquidityPairScopeKey,
  chainCacheTag,
};
