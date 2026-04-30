/**
 * @file src/position-manager.js
 * @module position-manager
 * @description
 * Central orchestrator for managing multiple LP positions simultaneously.
 * Each managed position gets its own independent `startBotLoop()` instance
 * sharing a single wallet (provider + signer).  A rebalance lock serializes
 * on-chain transactions so only one position rebalances at a time (same
 * wallet = same nonce).
 *
 * Functional API — no classes, no mutable singleton state.  Call
 * `createPositionManager(opts)` to get a handle with start/stop/pause/resume.
 *
 * @example
 * const mgr = createPositionManager({ signer, provider, ethersLib, rebalanceLock });
 * await mgr.startPosition(compositeKey, { tokenId, botState, updateBotState });
 * mgr.getAll();  // → Map of managed positions
 */

"use strict";

const { Mutex } = require("async-mutex");
const { nextMidnight } = require("./throttle");
const { emojiId } = require("./logger");
const config = require("./config");
const { createProviderWithFallback } = require("./bot-provider");
const sendTx = require("./send-transaction");
const { createFailoverSigner } = require("./nonce-manager-wrapper");

/**
 * @typedef {Object} ManagedPosition
 * @property {string}   key       Composite key (blockchain-wallet-contract-tokenId).
 * @property {string}   tokenId   NFT token ID.
 * @property {string}   status    'running' | 'stopped'
 * @property {{ stop: Function }} [handle]  Bot loop handle.
 */

/**
 * Create a position manager.
 *
 * @param {object} opts
 * @param {object}   opts.rebalanceLock   Lock from createRebalanceLock().
 * @returns {object}  Position manager handle.
 */
function createPositionManager(opts) {
  const _rebalanceLock = opts.rebalanceLock;

  /** @type {Map<string, ManagedPosition>} */
  const _positions = new Map();

  /** Global scan lock — fallback for callers without pool context. */
  const _scanLock = new Mutex();

  /** Per-pool scan locks — different pools scan in parallel, same pool serializes. */
  const _poolScanLocks = new Map();

  /*- Shared wallet singleton — app-wide, one chain + one wallet at a
   *  time.  All managed positions sign through the SAME NonceManager so
   *  per-position counters cannot drift against each other (the root
   *  cause of the 2026-04-24 "nonce too low" storm on #159064 after
   *  #159065's rebalance bumped the chain nonce ~16 positions ahead of
   *  #159064's stale per-position NonceManager counter).  The
   *  rebalance-lock serialises TX submission, so a shared NonceManager
   *  is race-free.  First call wins; subsequent calls return the cached
   *  {provider, signer, address}. */
  let _sharedPromise = null;
  async function getSharedSigner(signerOpts) {
    if (_sharedPromise) return _sharedPromise;
    _sharedPromise = (async () => {
      const { privateKey, ethersLib, dryRun } = signerOpts || {};
      /*- Initialise the send-transaction module's primary + fallback
          providers from chain config.  Idempotent in spirit, but
          send-tx doesn't expose a "re-init" — first wallet wins for
          the lifetime of the process, which matches the singleton
          shared-signer contract. */
      sendTx.init(config.CHAIN.rpc, ethersLib);
      const provider = await createProviderWithFallback(
        config.RPC_URL,
        config.RPC_URL_FALLBACK,
        ethersLib,
      );
      const base =
        dryRun && !privateKey
          ? ethersLib.Wallet.createRandom().connect(provider)
          : new ethersLib.Wallet(privateKey, provider);
      /*- FailoverNonceManager rebinds its inner ethers.NonceManager when
          the active RPC flips, so the same shared signer transparently
          follows the failover window without callers needing to know. */
      const signer = createFailoverSigner(base, { ethersLib });
      const address = await signer.getAddress();
      console.log(
        "[pos-mgr] Shared signer initialised for %s (dryRun=%s)",
        address,
        !!dryRun,
      );
      return { provider, signer, address };
    })();
    try {
      return await _sharedPromise;
    } catch (err) {
      _sharedPromise = null;
      throw err;
    }
  }

  /** Clear the shared signer cache (tests / wallet-change). */
  function _resetSharedSigner() {
    _sharedPromise = null;
  }

  /**
   * Per-pool daily rebalance counters.
   * Key = "chain-contract-wallet-token0-token1-fee" (lowercase).
   * Matches the cache-scoping convention in CLAUDE.md so counts never
   * collide across chains, NFT providers (contracts), or wallets.
   */
  const _poolDailyCounts = new Map();
  const _clock = opts.nowFn || Date.now;
  let _poolResetAt = nextMidnight(_clock);

  /**
   * Build a fully-qualified pool key.  The namespace (chain, contract,
   * wallet) is required so a single wallet running multiple NFT providers
   * (or the same pool on two chains) cannot cross-count.  Token
   * addresses are sorted for a canonical ordering regardless of how the
   * caller orders them.
   */
  function poolKey(chain, contract, wallet, token0, token1, fee) {
    const a = String(token0).toLowerCase(),
      b = String(token1).toLowerCase();
    const pair = a < b ? a + "-" + b : b + "-" + a;
    return (
      String(chain).toLowerCase() +
      "-" +
      String(contract).toLowerCase() +
      "-" +
      String(wallet).toLowerCase() +
      "-" +
      pair +
      "-" +
      fee
    );
  }

  /** Reset all pool counters at midnight UTC. */
  function _tickPoolDaily() {
    if (_clock() >= _poolResetAt) {
      _poolDailyCounts.clear();
      _poolResetAt = nextMidnight(_clock);
    }
  }

  /** Get the current daily rebalance count for a pool. */
  function getPoolDailyCount(pk) {
    _tickPoolDaily();
    return _poolDailyCounts.get(pk) || 0;
  }

  /** Check whether a pool can rebalance (count < max). */
  function canRebalancePool(pk, max) {
    return getPoolDailyCount(pk) < max;
  }

  /** Record a rebalance for a pool. */
  function recordPoolRebalance(pk) {
    _tickPoolDaily();
    _poolDailyCounts.set(pk, (_poolDailyCounts.get(pk) || 0) + 1);
  }

  /** Get all pool daily counts (for status response). */
  function getPoolDailyCounts() {
    _tickPoolDaily();
    return Object.fromEntries(_poolDailyCounts);
  }

  /**
   * Seed per-pool counters from historical rebalance log entries so a
   * bot restart does not silently reset the daily cap.  Only counts
   * entries logged since today's UTC midnight.  Entries missing any
   * namespace field (chain/contract/wallet/token0/token1/fee) are
   * skipped — they simply do not contribute, which is safe (under-count,
   * never over-count).  Pre-fix log rows written before full
   * qualification was rolled out lack chain/contract/wallet and will
   * self-heal as new rebalances land.
   *
   * @param {Array<object>} entries  Rebalance log rows; each expects
   *   `chain`, `contract`, `wallet`, `token0`, `token1`, `fee`, and
   *   `loggedAt` (ISO string).
   * @returns {number}  Number of entries counted.
   */
  function seedPoolDailyCounts(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const startOfDay = nextMidnight(_clock) - 86_400_000;
    let counted = 0;
    for (const e of entries) {
      if (!e || !e.token0 || !e.token1) continue;
      if (!e.chain || !e.contract || !e.wallet) continue;
      if (e.fee === null || e.fee === undefined) continue;
      if (!e.loggedAt) continue;
      const ts = Date.parse(e.loggedAt);
      if (Number.isNaN(ts) || ts < startOfDay) continue;
      const pk = poolKey(
        e.chain,
        e.contract,
        e.wallet,
        e.token0,
        e.token1,
        e.fee,
      );
      _poolDailyCounts.set(pk, (_poolDailyCounts.get(pk) || 0) + 1);
      counted++;
    }
    return counted;
  }

  /**
   * Start managing a position.
   *
   * @param {string} key               Composite key.
   * @param {object} posOpts
   * @param {string}   posOpts.tokenId    NFT token ID.
   * @param {Function} posOpts.startLoop  Async function that starts the bot loop.
   *   Returns `{ stop() }`.  The caller (server-positions.js) is responsible
   *   for wiring up the bot state and dependencies.
   * @param {object}   [posOpts.savedConfig]  Saved position config from disk.
   * @returns {Promise<void>}
   */
  async function startPosition(key, posOpts) {
    const { tokenId, startLoop } = posOpts;

    if (_positions.has(key) && _positions.get(key).status === "running") {
      console.log("[pos-mgr] Position %s already running", key);
      return;
    }

    const handle = await startLoop();

    _positions.set(key, { key, tokenId, status: "running", handle });
    console.log(
      "[pos-mgr] Started managing position %s (tokenId=%s %s)",
      key,
      tokenId,
      emojiId(tokenId),
    );
  }

  /**
   * Stop and remove a position from management.
   * @param {string} key  Composite key.
   * @returns {Promise<void>}
   */
  async function removePosition(key) {
    const entry = _positions.get(key);
    if (!entry) return;
    if (entry.handle) await entry.handle.stop();
    _positions.delete(key);
    console.log("[pos-mgr] Removed position %s", key);
  }

  /**
   * Stop all managed positions.
   * @returns {Promise<void>}
   */
  async function stopAll() {
    const stops = [];
    for (const [, entry] of _positions) {
      if (entry.handle) stops.push(entry.handle.stop());
    }
    await Promise.all(stops);
    for (const [, entry] of _positions) {
      entry.handle = null;
      entry.status = "stopped";
    }
    console.log("[pos-mgr] All positions stopped");
  }

  /**
   * Update a position's composite key after rebalance mints a new NFT.
   * @param {string} oldKey  Previous composite key.
   * @param {string} newKey  New composite key.
   * @param {string} newTokenId  New NFT token ID.
   */
  function migrateKey(oldKey, newKey, newTokenId) {
    if (oldKey === newKey) return;
    const entry = _positions.get(oldKey);
    if (!entry) return;
    _positions.delete(oldKey);
    entry.key = newKey;
    entry.tokenId = newTokenId;
    _positions.set(newKey, entry);
    console.log(
      "[pos-mgr] Migrated key %s → %s %s",
      oldKey,
      newKey,
      emojiId(newTokenId),
    );
  }

  /**
   * Get all managed positions with their status.
   * @returns {Array<{ key: string, tokenId: string, status: string }>}
   */
  function getAll() {
    return Array.from(_positions.values()).map(({ key, tokenId, status }) => ({
      key,
      tokenId,
      status,
    }));
  }

  /**
   * Get a single managed position by key.
   * @param {string} key  Composite key.
   * @returns {ManagedPosition|undefined}
   */
  function get(key) {
    return _positions.get(key);
  }

  /** Number of currently managed positions. */
  function count() {
    return _positions.size;
  }

  /** Number of currently running positions. */
  function runningCount() {
    let n = 0;
    for (const [, e] of _positions) if (e.status === "running") n++;
    return n;
  }

  /** The shared rebalance lock (for callers that need nonce-safe TX serialization). */
  function getRebalanceLock() {
    return _rebalanceLock;
  }

  /** The shared scan lock — callers acquire before running event scans. */
  function getScanLock() {
    return _scanLock;
  }

  /**
   * Per-pool scan lock — different pools scan in parallel.
   * @param {string} pk  Pool key from poolKey().
   * @returns {Mutex}
   */
  function getPoolScanLock(pk) {
    if (!_poolScanLocks.has(pk)) _poolScanLocks.set(pk, new Mutex());
    return _poolScanLocks.get(pk);
  }

  return {
    startPosition,
    removePosition,
    stopAll,
    migrateKey,
    getAll,
    get,
    count,
    runningCount,
    poolKey,
    getPoolDailyCount,
    canRebalancePool,
    recordPoolRebalance,
    getPoolDailyCounts,
    seedPoolDailyCounts,
    getRebalanceLock,
    getScanLock,
    getPoolScanLock,
    getSharedSigner,
    _resetSharedSigner,
  };
}

module.exports = { createPositionManager };
