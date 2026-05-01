/**
 * @file src/server-positions.js
 * @module server-positions
 * @description
 * Multi-position management route handlers and state helpers for the server.
 * Extracted from server.js to stay within the 500-line limit.
 *
 * Provides:
 *  - Per-position bot state creation and update
 *  - API route handlers: manage, pause, resume, remove, list
 *  - Composite key migration after rebalance
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const { setCachedEpochs } = require("./epoch-cache");
const { startBotLoop } = require("./bot-loop");
const {
  compositeKey,
  parseCompositeKey,
  saveConfig,
  getPositionConfig,
  readConfigValue,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey: migrateConfigKey,
} = require("./bot-config-v2");

/** Per-position bot state (in-memory, keyed by composite key). */
const _positionBotStates = new Map();

/**
 * Create a fresh per-position bot state with defaults + saved config.
 * @param {object} globalCfg  Global config section from v2 disk config.
 * @param {object} [saved]    Saved position config from disk.
 * @returns {object}
 */
function createPerPositionBotState(_globalCfg, saved) {
  const state = {
    running: false,
    startedAt: null,
    activePosition: null,
    rebalanceCount: 0,
    lastRebalanceAt: null,
    rebalanceError: null,
    rebalancePaused: false,
    rebalanceScanComplete: false,
    rebalanceScanProgress: 0,
  };
  if (saved) {
    if (saved.hodlBaseline) state.hodlBaseline = saved.hodlBaseline;
    if (saved.residuals) state.residuals = saved.residuals;
    if (saved.collectedFeesUsd) state.collectedFeesUsd = saved.collectedFeesUsd;
    if (saved.totalCompoundedUsd)
      state.totalCompoundedUsd = saved.totalCompoundedUsd;
    if (saved.compoundHistory) state.compoundHistory = saved.compoundHistory;
    if (saved.lastCompoundAt) state.lastCompoundAt = saved.lastCompoundAt;
  }
  return state;
}

function _persistEpochCache(state, epochs) {
  const ap = state.activePosition;
  if (!ap || !ap.token0 || !ap.fee) return;
  setCachedEpochs(
    {
      contract: config.POSITION_MANAGER,
      wallet: state.walletAddress || "",
      token0: ap.token0,
      token1: ap.token1,
      fee: ap.fee,
    },
    epochs,
  );
}

/**
 * Update per-position state and persist when needed.
 * @param {string} key          Composite key.
 * @param {object} patch        State patch from the bot loop.
 * @param {object} diskConfig   V2 disk config (mutated + saved).
 * @param {object} positionMgr  Position manager instance.
 */
/** Persist position-scoped fields from a bot state patch to disk config. */
function _persistPositionConfig(patch, diskConfig, key, dir) {
  const _PERSIST = [
    "hodlBaseline",
    "residuals",
    "collectedFeesUsd",
    "compoundHistory",
    "totalCompoundedUsd",
    "lastCompoundAt",
  ];
  const changed = _PERSIST.filter((k) => patch[k] !== undefined);
  const needsSave = !!patch.activePositionId || changed.length > 0;
  if (!needsSave) return;
  const pos = getPositionConfig(diskConfig, key);
  const hadStatus = pos.status;
  for (const k of changed) pos[k] = patch[k];
  /* Guard: if we're saving for a managed position, ensure status survives */
  if (!pos.status) {
    console.warn(
      "[pos-state] status missing for %s (was %s) — restoring to running. " +
        "Patch keys: %s",
      key,
      hadStatus,
      Object.keys(patch).join(", "),
    );
    pos.status = "running";
  }
  console.log(
    "[pos-state] Persist %s for %s (status=%s)",
    changed.join(", ") || "activePositionId",
    key,
    pos.status,
  );
  saveConfig(diskConfig, dir);
}

function updatePositionState(keyRef, patch, diskConfig, positionMgr, dir) {
  const key = keyRef.current;
  let state = _positionBotStates.get(key);
  if (!state) {
    state = {};
    _positionBotStates.set(key, state);
  }
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });

  // Persist position-specific data to v2 config when important fields change
  if (patch.pnlEpochs) _persistEpochCache(state, patch.pnlEpochs);
  _persistPositionConfig(patch, diskConfig, key, dir);

  // Handle key migration after rebalance (new tokenId) — save disk first, then memory.
  // Update keyRef.current so ALL closures (updateBotState, getConfig) use the new key.
  const parsed = parseCompositeKey(key);
  if (
    parsed &&
    patch.activePositionId &&
    String(patch.activePositionId) !== parsed.tokenId
  ) {
    const newKey = compositeKey(
      parsed.blockchain,
      parsed.wallet,
      parsed.contract,
      String(patch.activePositionId),
    );
    console.log(
      "[pos-state] Key migration: %s → %s (new tokenId=%s)",
      key,
      newKey,
      patch.activePositionId,
    );
    migrateConfigKey(diskConfig, key, newKey);
    saveConfig(diskConfig, dir);
    // No epoch-cache migration needed — keyed by pool, not tokenId
    positionMgr.migrateKey(key, newKey, String(patch.activePositionId));
    state.forceRebalance = false;
    state.rebalancePaused = false;
    state.rebalanceError = null;
    _positionBotStates.set(newKey, state);
    _positionBotStates.delete(key);
    keyRef.current = newKey;
  }
}

/**
 * Attach multi-position deps (lock, daily cap, scan lock) to a bot state.
 * These are read by bot-loop.js during pollCycle and startBotLoop.
 * @param {object} botState      Per-position bot state.
 * @param {object} positionMgr   Position manager instance.
 */
function attachMultiPosDeps(botState, positionMgr) {
  botState._rebalanceLock = positionMgr.getRebalanceLock();
  botState._scanLock = positionMgr.getScanLock();
  botState._getPoolScanLock = positionMgr.getPoolScanLock;
  /*- Bind chain + NFT provider contract + wallet so bot-cycle call
   *  sites stay the simple (t0, t1, fee) shape.  Wallet is looked up
   *  lazily from botState because it can be populated after attach. */
  botState._poolKey = (t0, t1, f) =>
    positionMgr.poolKey(
      config.CHAIN_NAME,
      config.POSITION_MANAGER,
      botState.walletAddress || "",
      t0,
      t1,
      f,
    );
  botState._canRebalancePool = positionMgr.canRebalancePool;
  botState._recordPoolRebalance = positionMgr.recordPoolRebalance;
  /**
   * Sum the in-position amount of a token across all managed positions.
   * Used for pro-rata wallet residual split.
   * @param {string} tokenAddress  ERC-20 address to look up.
   * @returns {number} Total human-readable amount across all positions.
   */
  botState._getTokenPositionAmounts = (tokenAddress) => {
    const ta = tokenAddress.toLowerCase();
    let total = 0;
    for (const [, s] of _positionBotStates) {
      if (!s.running || !s.positionStats) continue;
      const ap = s.activePosition;
      if (!ap) continue;
      if (ap.token0?.toLowerCase() === ta)
        total += Number(s.positionStats.balance0) || 0;
      if (ap.token1?.toLowerCase() === ta)
        total += Number(s.positionStats.balance1) || 0;
    }
    return total;
  };
}

/**
 * Get all per-position bot states.
 * @returns {Map<string, object>}
 */
function getAllPositionBotStates() {
  return _positionBotStates;
}

/**
 * Build an `onRetire` callback for a bot loop managing a single
 * position.  The bot loop calls this after it has already stopped its
 * own timer on detection of a drained-for-too-long NFT; we just need to
 * flip the on-disk status to 'stopped', clear auto-compound so it
 * doesn't resume on next manage, drop the in-memory bot state, and
 * mark the position manager entry as stopped.  NFT is never burned.
 *
 * @param {object} deps
 * @param {{ current: string }} deps.keyRef  Live composite key (mutates after rebalance).
 * @param {object} deps.diskConfig           V2 disk config.
 * @param {object} deps.positionMgr          Position manager instance.
 * @returns {Function}  Async `(tokenId) => void` suitable for `opts.onRetire`.
 */
function createOnRetire(deps) {
  const { keyRef, diskConfig, positionMgr } = deps;
  return async function _onRetire(tokenId) {
    const k = keyRef.current;
    console.log(
      "[pos-state] Auto-retiring drained position %s (tokenId=%s)",
      k,
      tokenId,
    );
    removeManagedPosition(diskConfig, k);
    const posRef = diskConfig.positions[k];
    if (posRef) posRef.autoCompoundEnabled = false;
    saveConfig(diskConfig);
    _positionBotStates.delete(k);
    /*- The bot-loop's stop() is already idempotent and its timer is
     *  cleared — calling positionMgr.removePosition here deletes the
     *  in-memory entry and safely no-ops the handle.stop() call. */
    try {
      await positionMgr.removePosition(k);
    } catch (err) {
      console.warn(
        "[pos-state] removePosition failed during retire for %s: %s",
        k,
        err.message,
      );
    }
  };
}

/**
 * Create route handlers for multi-position management.
 * @param {object} deps
 * @param {object} deps.diskConfig     V2 disk config.
 * @param {object} deps.positionMgr    Position manager instance.
 * @param {object} deps.walletManager  Wallet manager instance.
 * @param {Function} deps.getPrivateKey  Returns resolved private key.
 * @param {Function} deps.jsonResponse   JSON response helper.
 * @param {Function} deps.readJsonBody   JSON body reader.
 * @returns {object}  Map of route key → handler.
 */
/** Keys currently in the process of starting (guards against concurrent requests). */
const _starting = new Set();

function createPositionRoutes(deps) {
  const {
    diskConfig,
    positionMgr,
    walletManager,
    getPrivateKey,
    jsonResponse,
    readJsonBody,
  } = deps;

  async function handleManage(req, res) {
    const body = await readJsonBody(req);
    if (!body.tokenId || !/^\d+$/.test(String(body.tokenId))) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Missing or invalid tokenId (must be numeric)",
      });
      return;
    }
    const blockchain = body.blockchain || "pulsechain";
    const contract = body.contract || config.POSITION_MANAGER;
    const wallet = walletManager.getAddress();
    if (!wallet) {
      jsonResponse(res, 400, { ok: false, error: "No wallet loaded" });
      return;
    }
    const pk = getPrivateKey();
    if (!pk) {
      jsonResponse(res, 400, {
        ok: false,
        error: "No private key available",
      });
      return;
    }
    const key = compositeKey(
      blockchain,
      wallet,
      contract,
      String(body.tokenId),
    );
    console.log(
      "[pos-route] POST /api/position/manage tokenId=%s key=%s",
      body.tokenId,
      key,
    );

    // If already running or currently starting, skip duplicate.
    // Note: only checks IN-MEMORY state. A stale `status=running` on disk
    // with no live bot loop is treated as not-running, so the user can
    // retry Manage to actually start it.
    const existing = positionMgr.get(key);
    if ((existing && existing.status === "running") || _starting.has(key)) {
      console.log(
        "[pos-route] Position #%s already running or starting — skipping",
        body.tokenId,
      );
      jsonResponse(res, 200, {
        ok: true,
        key,
        tokenId: String(body.tokenId),
        alreadyRunning: true,
      });
      return;
    }
    _starting.add(key);

    /*- Build the per-position config in memory only.  We DO NOT
     *  saveConfig() until startBotLoop succeeds: a failure here used to
     *  leave a phantom `status=running` entry on disk which made the
     *  dashboard show "Being Actively Managed" for a position that
     *  never actually started.  See PR fix-no-nft-found-error. */
    const posConfig = getPositionConfig(diskConfig, key);
    const _hadExistingConfig = Object.keys(posConfig).length > 0;
    const _prevStatus = posConfig.status;
    if (posConfig.autoCompoundEnabled === undefined) {
      const liq = body.liquidity;
      posConfig.autoCompoundEnabled = !liq || BigInt(liq) > 0n;
    }
    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, positionMgr);
    _positionBotStates.set(key, posBotState);

    const t0 = Date.now();
    const keyRef = { current: key };
    /*- Fetch (or reuse) the app-wide shared signer before starting the
     *  bot loop.  Every managed position must use the SAME NonceManager
     *  — see positionMgr.getSharedSigner for the rationale. */
    const shared = await positionMgr.getSharedSigner({
      privateKey: pk,
      ethersLib: ethers,
      dryRun: config.DRY_RUN,
    });
    try {
      await positionMgr.startPosition(key, {
        tokenId: String(body.tokenId),
        startLoop: () =>
          startBotLoop({
            privateKey: pk,
            provider: shared.provider,
            signer: shared.signer,
            address: shared.address,
            dryRun: config.DRY_RUN,
            eagerScan: false,
            updateBotState: (patch) =>
              updatePositionState(keyRef, patch, diskConfig, positionMgr),
            botState: posBotState,
            positionId: String(body.tokenId),
            getConfig: (k) => readConfigValue(diskConfig, keyRef.current, k),
            getPositionCount: () => positionMgr.runningCount(),
            onRetire: createOnRetire({ keyRef, diskConfig, positionMgr }),
          }),
        savedConfig: posConfig,
      });
    } catch (err) {
      console.error(
        "[pos-route] Failed to start position #%s (key=%s): %s\n%s",
        body.tokenId,
        key,
        err.message,
        err.stack,
      );
      /*- Roll back in-memory state so a retry starts cleanly and so the
       *  status endpoint doesn't show a phantom managed entry. */
      _positionBotStates.delete(key);
      if (!_hadExistingConfig) {
        delete diskConfig.positions[key];
      } else {
        // Preserve prior status (e.g. `stopped`) — never auto-promote to running
        posConfig.status = _prevStatus;
      }
      jsonResponse(res, 500, {
        ok: false,
        error: "Failed to start position: " + err.message,
      });
      return;
    } finally {
      _starting.delete(key);
    }
    /*- Bot loop is up; only NOW persist `status=running`. */
    addManagedPosition(diskConfig, key);
    saveConfig(diskConfig);
    console.log(
      "[pos-route] Position #%s started in %dms (total managed: %d)",
      body.tokenId,
      Date.now() - t0,
      positionMgr.count(),
    );

    jsonResponse(res, 200, {
      ok: true,
      key,
      tokenId: String(body.tokenId),
    });
  }

  async function handleRemove(req, res) {
    const body = await readJsonBody(req);
    if (!body.key) {
      jsonResponse(res, 400, { ok: false, error: "Missing key" });
      return;
    }
    console.log("[pos-route] DELETE /api/position/manage key=%s", body.key);
    try {
      await positionMgr.removePosition(body.key);
    } catch (err) {
      console.error(
        "[pos-route] Failed to remove position %s: %s\n%s",
        body.key,
        err.message,
        err.stack,
      );
    }
    removeManagedPosition(diskConfig, body.key);
    // Clear auto-compound so it doesn't re-enable on next manage
    const posRef = diskConfig.positions[body.key];
    if (posRef) posRef.autoCompoundEnabled = false;
    saveConfig(diskConfig);
    _positionBotStates.delete(body.key);
    console.log(
      "[pos-route] Position removed (remaining: %d)",
      positionMgr.count(),
    );
    jsonResponse(res, 200, { ok: true, key: body.key, status: "stopped" });
  }

  function handleManagedList(_req, res) {
    const all = positionMgr.getAll();
    // Attach per-position bot state summaries
    const positions = all.map((p) => {
      const bs = _positionBotStates.get(p.key);
      return {
        ...p,
        ...(bs
          ? { activePosition: bs.activePosition, running: bs.running }
          : {}),
      };
    });
    jsonResponse(res, 200, { ok: true, positions });
  }

  return {
    "POST /api/position/manage": handleManage,
    "DELETE /api/position/manage": handleRemove,
    "GET /api/positions/managed": handleManagedList,
  };
}

/**
 * Attach a canonical `poolKey` string to each managed-position entry in
 * the status response, so the dashboard can look up per-pool daily
 * counts in `global.poolDailyCounts` without rebuilding the key format
 * on the client. Single source of truth: `positionMgr.poolKey()`.
 *
 * Entries without `activePosition` (e.g. unmanaged positions) are left
 * untouched — they have no per-pool counter to correlate.
 *
 * @param {Record<string, object>} positions   Positions map from status.
 * @param {object} positionMgr                 Position manager with poolKey().
 * @param {object} cfg                         Config object with CHAIN_NAME + POSITION_MANAGER.
 */
function attachPoolKeys(positions, positionMgr, cfg) {
  for (const entry of Object.values(positions)) {
    const ap = entry.activePosition;
    const ok =
      entry.walletAddress &&
      ap &&
      ap.token0 &&
      ap.token1 &&
      ap.fee !== null &&
      ap.fee !== undefined;
    if (!ok) continue;
    entry.poolKey = positionMgr.poolKey(
      cfg.CHAIN_NAME,
      cfg.POSITION_MANAGER,
      entry.walletAddress,
      ap.token0,
      ap.token1,
      ap.fee,
    );
  }
}

/**
 * Settings keys that flow through to the dashboard for *unmanaged*
 * positions (so the user sees persisted settings for positions the bot
 * isn't actively managing, e.g. closed-view or paused positions).
 */
const _UNMANAGED_SETTINGS_KEYS = [
  "rebalanceOutOfRangeThresholdPercent",
  "rebalanceTimeoutMin",
  "slippagePct",
  "checkIntervalSec",
  "minRebalanceIntervalMin",
  "maxRebalancesPerDay",
  "gasStrategy",
  "priceOverride0",
  "priceOverride1",
  "priceOverrideForce",
  "autoCompoundEnabled",
  "autoCompoundThresholdUsd",
  "totalCompoundedUsd",
  "lastCompoundAt",
  "offsetToken0Pct",
];

/**
 * Build the `positions` map for the GET /api/status response: merges
 * per-position bot state, disk config, and sensible defaults; attaches a
 * canonical poolKey to every managed entry. Unmanaged positions (in
 * disk config but not currently running) get a lightweight subset of
 * their persisted settings so the dashboard UI still has context.
 *
 * @param {object} diskConfig   Parsed bot-config (has `.positions` map).
 * @param {object} posDefaults  Base defaults applied to every entry.
 * @param {object} positionMgr  Position manager (exposes poolKey()).
 * @param {object} cfg          Config object with CHAIN_NAME + POSITION_MANAGER.
 * @returns {Record<string, object>}
 */
function buildStatusPositions(diskConfig, posDefaults, positionMgr, cfg) {
  const positions = {};
  for (const [key, state] of getAllPositionBotStates()) {
    const posConfig = diskConfig.positions[key] || {};
    positions[key] = { ...posDefaults, ...state, ...posConfig };
  }
  for (const [key, posConfig] of Object.entries(diskConfig.positions)) {
    if (positions[key]) continue;
    const s = { ...posDefaults };
    for (const k of _UNMANAGED_SETTINGS_KEYS)
      if (posConfig[k] !== undefined) s[k] = posConfig[k];
    positions[key] = s;
  }
  attachPoolKeys(positions, positionMgr, cfg);
  return positions;
}

module.exports = {
  createPerPositionBotState,
  attachMultiPosDeps,
  attachPoolKeys,
  buildStatusPositions,
  updatePositionState,
  getAllPositionBotStates,
  createOnRetire,
  createPositionRoutes,
};
