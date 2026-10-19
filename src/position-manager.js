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

const { log } = require("./log");
const { poolKey } = require("./pool-key");
const { Mutex } = require("async-mutex");
const { nextMidnight } = require("./throttle");
const { emojiId } = require("./logger");
const config = require("./config");
const sendTx = require("./send-transaction");
const { createFailoverSigner } = require("./nonce-manager-wrapper");
const { isStopping } = require("./app-phase");

/**
 * @typedef {Object} ManagedPosition
 * @property {string}   key       Composite key (blockchain-wallet-contract-tokenId).
 * @property {string}   tokenId   NFT token ID.
 * @property {string}   status    'running' | 'stopped'
 * @property {{ stop: Function }|null} handle  Bot loop handle; null until
 *   the loop has started, and again once stopped.
 * @property {Promise<void>|null} starting  The start under way, settled
 *   once the loop's first check has ended; null at any other time.
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
          providers from chain config.  init() is idempotent: a
          subsequent call from bot-loop or server.js with the same
          URLs is a no-op.  ensureReachable() probes the primary and
          engages failoverToNextRPC() if it's down at boot. */
      sendTx.init({ urls: config.RPC_URLS }, ethersLib);
      await sendTx.ensureReachable();
      const provider = sendTx.getManagedReadProvider();
      const base =
        dryRun && !privateKey
          ? ethersLib.Wallet.createRandom().connect(provider)
          : new ethersLib.Wallet(privateKey, provider);
      /*- FailoverNonceManager rebinds its inner ethers.NonceManager when
          the active RPC flips, so the same shared signer transparently
          follows the failover window without callers needing to know. */
      const signer = createFailoverSigner(base, { ethersLib });
      const address = await signer.getAddress();
      log.info(
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

  /**
   * Forget the shared signer, so the next `getSharedSigner` builds one
   * from the key it is then given. Called when a different wallet is
   * imported (`_handleWalletImport`, src/server-routes.js): the cached
   * signer would otherwise go on signing with the old wallet's key, and
   * every rebalance of the new wallet's positions would fail at the
   * ownership check.
   */
  function resetSharedSigner() {
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
   * A position's bot loop runs its first check of the pool before
   * `startLoop` returns the loop's handle, and that check can rebalance.
   * So the position is recorded first, with no handle yet and its start
   * under way, where everything that looks positions up finds it: a
   * rebalance in that first check moves its key (`migrateKey`), a stop of
   * every position waits for the start and then stops the loop
   * (`stopAll`), and a second start of the same key does nothing. Once
   * the app is stopping for good, no start begins.
   *
   * @param {string} key               Composite key.
   * @param {object} posOpts
   * @param {string}   posOpts.tokenId    NFT token ID.
   * @param {Function} posOpts.startLoop  Async function that starts the bot loop.
   *   Returns `{ stop() }`.  The caller (server-positions.js) is responsible
   *   for wiring up the bot state and dependencies.
   * @param {object}   [posOpts.savedConfig]  Saved position config from disk.
   * @returns {Promise<void>} Rejects when the app is stopping, when the
   *   loop fails to start, or when the position was removed while it
   *   started.
   */
  async function startPosition(key, posOpts) {
    const { tokenId, startLoop } = posOpts;
    if (isStopping())
      throw new Error(
        `LP Ranger is stopping, so position ${key} does not start`,
      );

    const existing = _positions.get(key);
    if (existing !== undefined && existing.status === "running") {
      log.info("[pos-mgr] Position %s already running", key);
      return;
    }

    const entry = {
      key,
      tokenId,
      status: "running",
      handle: null,
      starting: null,
    };
    _positions.set(key, entry);
    entry.starting = _runStart(entry, startLoop);
    try {
      await entry.starting;
    } finally {
      entry.starting = null;
    }
    log.info(
      "[pos-mgr] Started managing position %s (tokenId=%s %s)",
      entry.key,
      entry.tokenId,
      emojiId(entry.tokenId),
    );
  }

  /**
   * Start `entry`'s loop and record its handle. A position removed while
   * it started, by a Stop Managing or a retire in its first check, has
   * nothing left to record the loop under, so the loop is stopped.
   * @param {ManagedPosition} entry
   * @param {Function} startLoop
   * @returns {Promise<void>}
   */
  async function _runStart(entry, startLoop) {
    let handle;
    try {
      handle = await startLoop();
    } catch (err) {
      if (_positions.get(entry.key) === entry) _positions.delete(entry.key);
      throw err;
    }
    if (_positions.get(entry.key) !== entry) {
      await handle.stop();
      throw new Error(`position ${entry.key} was removed while it started`);
    }
    entry.handle = handle;
  }

  /**
   * Stop and remove a position from management. One still starting is
   * removed at once, and its start stops the loop once it has one, since
   * waiting for the start here would wait on a retire inside that very
   * start.
   * @param {string} key  Composite key.
   * @returns {Promise<void>}
   */
  async function removePosition(key) {
    const entry = _positions.get(key);
    if (!entry) return;
    if (entry.handle) await entry.handle.stop();
    /*- During `handle.stop()` an in-flight poll may complete and run a
     *  rebalance whose `updatePositionState` invokes `migrateKey`,
     *  rewriting entry.key in place and reseating the entry under the
     *  new key in `_positions`.  Delete by `entry.key` (the live key)
     *  rather than the original `key` argument so the in-memory map
     *  is correctly cleaned regardless of migration timing. */
    _positions.delete(entry.key);
    log.info("[pos-mgr] Removed position %s", entry.key);
  }

  /**
   * Stop all managed positions, resolving once each loop's check under
   * way has ended. A position still starting has no loop to stop until
   * its first check ends, so its start is waited for and the loop it
   * records is stopped then. Only the positions held when the call came
   * are marked stopped: one whose start begins during the wait keeps its
   * loop, and with it the record that the loop runs.
   * @returns {Promise<void>}
   */
  async function stopAll() {
    const entries = [..._positions.values()];
    const stops = [];
    for (const entry of entries) {
      if (entry.handle !== null) stops.push(entry.handle.stop());
      else if (entry.starting !== null)
        stops.push(
          entry.starting.then(
            () => entry.handle?.stop(),
            () => {},
          ),
        );
    }
    await Promise.all(stops);
    for (const entry of entries) {
      entry.handle = null;
      entry.status = "stopped";
    }
    log.info("[pos-mgr] All positions stopped");
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
    log.info(
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
    resetSharedSigner,
  };
}

module.exports = { createPositionManager };
