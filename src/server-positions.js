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

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const { setCachedEpochs } = require("./epoch-cache");
const { startBotLoop } = require("./bot-loop");
const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
} = require("./pool-state-validate");
const { createCanReopenHandler } = require("./server-can-reopen");
const {
  compositeKey,
  parseCompositeKey,
  saveConfig,
  getPositionConfig,
  getOrCreatePositionConfig,
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
    /*- Lifetime-deposit scan readiness.  Flips to true only when the
     *  bot's lifetime scan completes successfully AND produces a
     *  positive `totalLifetimeDepositUsd`.  Drives the Syncing badge
     *  + top-panel blur via `_syncStatus` in dashboard-data.js so the
     *  Lifetime panel never renders with a stale/zero deposit. */
    lifetimeScanComplete: false,
    /*- Balanced-band Telegram notifier transient state (process-lifetime
     *  only; not persisted to bot-config.json).  Owned by
     *  src/telegram-notifications/balanced-notifier.js — see CLAUDE.md "Balanced-Band Telegram
     *  Notification". */
    _lastInBand: false,
    _lastBalancedNotifyTs: 0,
    _lastBalancedPriceFetchTs: 0,
  };
  if (saved) {
    if (saved.hodlBaseline) state.hodlBaseline = saved.hodlBaseline;
    if (saved.residuals) state.residuals = saved.residuals;
    if (saved.collectedFeesUsd) state.collectedFeesUsd = saved.collectedFeesUsd;
    if (saved.totalCompoundedUsd)
      state.totalCompoundedUsd = saved.totalCompoundedUsd;
    if (saved.compoundHistory) state.compoundHistory = saved.compoundHistory;
    if (saved.nftGasWeiByTokenId)
      state.nftGasWeiByTokenId = saved.nftGasWeiByTokenId;
    if (saved.nftCompoundedUsdByTokenId)
      state.nftCompoundedUsdByTokenId = saved.nftCompoundedUsdByTokenId;
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
    "nftGasWeiByTokenId",
    "nftCompoundedUsdByTokenId",
    "lastCompoundAt",
  ];
  const changed = _PERSIST.filter((k) => patch[k] !== undefined);
  const needsSave = !!patch.activePositionId || changed.length > 0;
  if (!needsSave) return;
  /*- Non-lazy lookup: a slot SHOULD exist by now (handleManage created
   *  it before starting the bot loop).  If it's missing, refuse to
   *  create — the previous lazy-create produced phantom entries under
   *  stale keys whenever a patch was persisted for a position whose
   *  key had since migrated.  Warn loudly so the caller can investigate
   *  rather than silently re-creating the phantom. */
  const pos = getPositionConfig(diskConfig, key);
  if (!pos) {
    log.warn(
      "[pos-state] skipping persist for %s — slot missing on disk " +
        "(likely migrated away). Patch keys: %s",
      key,
      Object.keys(patch).join(", "),
    );
    return;
  }
  const hadStatus = pos.status;
  for (const k of changed) pos[k] = patch[k];
  /* Guard: if we're saving for a managed position, ensure status survives */
  if (!pos.status) {
    log.warn(
      "[pos-state] status missing for %s (was %s) — restoring to running. " +
        "Patch keys: %s",
      key,
      hadStatus,
      Object.keys(patch).join(", "),
    );
    pos.status = "running";
  }
  log.info(
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
    log.info(
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
    log.info(
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
      log.warn(
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

/*- Closed-position re-open path: when the dashboard calls Manage on a
 *  drained (liquidity=0) position, it sends `forceRebalance: true`.
 *  Stamp the flag on the freshly-built posBotState BEFORE startPosition
 *  so the bot loop's first poll sees the flag set; `bot-cycle-drain.js`'s
 *  `if (drained && !state.forceRebalance && !midwayFail)` guard then
 *  returns null and the rebalance pipeline runs on the drained NFT,
 *  minting fresh liquidity and bringing the position back to life in
 *  one user-driven cycle.  No-op for healthy positions (body.flag
 *  unset).
 *
 *  Range width for the re-open: read from persistent config
 *  (`rebalanceRangeWidthPct` POSITION_KEY) by the bot loop via
 *  `deps._getConfig` in src/bot-cycle-opts.js.  Falls back to
 *  `rangeMath.preserveRange()` when not set.  No longer read from the
 *  request body — the range-width modal has been migrated into Bot
 *  Settings; see the plan at
 *  `/home/christophermbalz/.claude/plans/encapsulated-coalescing-octopus.md`. */
function _stampReopenFlags(posBotState, body) {
  if (body.forceRebalance !== true) return;
  posBotState.forceRebalance = true;
}

/*- Already-running re-open path: when the user comes back to Manage
 *  after a swap-abort aborted the first re-open attempt, the
 *  `existing.status === "running"` guard in `handleManage` would
 *  silently no-op the request.  This helper grabs the live posBotState
 *  from the per-position map and stamps `forceRebalance` (via
 *  `_stampReopenFlags`) AND clears the aborted/midway flags
 *  (`rebalancePaused`, `rebalanceFailedMidway`, `rebalanceError`) so
 *  the next poll runs a fresh rebalance.  Range width comes from
 *  persistent config (`rebalanceRangeWidthPct` POSITION_KEY) — not
 *  from the request body — since the "Migrate Rebalance UI" plan.
 *  Returns true if the live state was found and stamped, false
 *  otherwise (the caller logs accordingly). */
function _stampReopenFlagsOnLive(key, body) {
  if (body.forceRebalance !== true) return false;
  const live = _positionBotStates.get(key);
  if (!live) return false;
  _stampReopenFlags(live, body);
  live.rebalancePaused = false;
  live.rebalanceFailedMidway = false;
  live.rebalanceError = null;
  /*- Critical: also clear `_retireImmediately`.  bot-loop.js's
   *  `_handleError` sets it after a re-open failure to trigger an
   *  immediate retire on the next bot poll.  If the user clicks
   *  Manage to retry within the ~60 s window before that poll fires,
   *  this code path (handleManage's already-running short-circuit)
   *  must clear the flag — otherwise drain.js's `_retireImmediately`
   *  branch fires retire BEFORE the forceRebalance can take effect,
   *  and the user's retry click is silently lost. */
  live._retireImmediately = false;
  return true;
}

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
    log.info(
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
      /*- Already-running short-circuit.  If the request carries
       *  `forceRebalance: true` (re-open retry path), stamp the flag
       *  onto the live posBotState + clear the aborted/midway state
       *  (rebalancePaused + rebalanceFailedMidway + rebalanceError) —
       *  the user has come back via Manage to retry after fixing
       *  slippage.  Without this, the second click is silently
       *  dropped and the re-open never retries.  Returns
       *  `reopenStamped: true` so the client can confirm the retry
       *  was wired through. */
      const stamped = _stampReopenFlagsOnLive(key, body);
      log.info(
        "[pos-route] Position #%s already running or starting — skipping%s",
        body.tokenId,
        stamped ? " (stamped reopen flags onto live state)" : "",
      );
      jsonResponse(res, 200, {
        ok: true,
        key,
        tokenId: String(body.tokenId),
        alreadyRunning: true,
        reopenStamped: stamped,
      });
      return;
    }
    _starting.add(key);

    /*- Build the per-position config in memory only.  We DO NOT
     *  saveConfig() until startBotLoop succeeds: a failure here used to
     *  leave a phantom `status=running` entry on disk which made the
     *  dashboard show "Being Actively Managed" for a position that
     *  never actually started.  See PR fix-no-nft-found-error.
     *
     *  Uses the lazy-create variant: this is the legitimate first-time
     *  creation site for a fresh managed position.  Disk persist is
     *  deferred to addManagedPosition + saveConfig after the bot loop
     *  starts successfully. */
    const posConfig = getOrCreatePositionConfig(diskConfig, key);
    const _hadExistingConfig = Object.keys(posConfig).length > 0;
    const _prevStatus = posConfig.status;
    if (posConfig.autoCompoundEnabled === undefined) {
      const liq = body.liquidity;
      posConfig.autoCompoundEnabled = !liq || BigInt(liq) > 0n;
    }
    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, positionMgr);
    _stampReopenFlags(posBotState, body);
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
      log.error(
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
      /*- Pool-state errors are user-actionable — surface them as 503 +
       *  a structured `pool-info-unavailable` code that the dashboard's
       *  `_handleManageFailure` recognizes and shows in a warning
       *  modal (with the raw `message` rendered in a scrollable code
       *  block).  Other errors keep the generic 500 path. */
      const isPoolStateErr =
        err instanceof PoolStateInvalidError ||
        err instanceof PoolStateUnavailableError;
      if (isPoolStateErr) {
        jsonResponse(res, 503, {
          ok: false,
          error: "pool-info-unavailable",
          message: err.message,
          tokenId: body.tokenId,
        });
      } else {
        jsonResponse(res, 500, {
          ok: false,
          error: "Failed to start position: " + err.message,
        });
      }
      return;
    } finally {
      _starting.delete(key);
    }
    /*- Bot loop is up; only NOW persist `status=running`.
     *
     *  Reads `keyRef.current`, NOT the captured local `key`.  When the
     *  bot's first poll runs a force-rebalance (re-open flow), the mint
     *  of a new NFT triggers `updatePositionState` to call
     *  `migrateConfigKey` + `positionMgr.migrateKey` + mutate
     *  `keyRef.current = newKey`.  By the time control returns here,
     *  the disk slot lives under the NEW key.  Calling
     *  `addManagedPosition(diskConfig, key)` with the STALE local
     *  would lazy-create an empty `{ status: "running" }`-only stub
     *  under the dead old key — the phantom that made the dashboard
     *  stuck on "Syncing…" for the closed view of the old NFT.
     *
     *  This is symmetric with `_onRetire` (which already reads
     *  `keyRef.current` at line 264) and the rest of the closures
     *  threaded into `startPosition`. */
    addManagedPosition(diskConfig, keyRef.current);
    saveConfig(diskConfig);
    log.info(
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
    log.info("[pos-route] DELETE /api/position/manage key=%s", body.key);
    /*- Capture entry reference BEFORE the await.  `positionMgr.migrateKey`
     *  mutates the entry object in place (entry.key = newKey) but
     *  preserves the object identity, so reading entry.key after the
     *  await gives the post-migration key if a rebalance migrated the
     *  position during the in-flight poll that handle.stop() awaited.
     *  Without this capture, the downstream cleanup uses the stale
     *  body.key and leaves a phantom under the migrated key. */
    const entry = positionMgr.get(body.key) || null;
    try {
      await positionMgr.removePosition(body.key);
    } catch (err) {
      log.error(
        "[pos-route] Failed to remove position %s: %s\n%s",
        body.key,
        err.message,
        err.stack,
      );
    }
    const liveKey = entry?.key || body.key;
    removeManagedPosition(diskConfig, liveKey);
    // Clear auto-compound so it doesn't re-enable on next manage
    const posRef = getPositionConfig(diskConfig, liveKey);
    if (posRef) posRef.autoCompoundEnabled = false;
    saveConfig(diskConfig);
    _positionBotStates.delete(liveKey);
    log.info(
      "[pos-route] Position removed (remaining: %d)",
      positionMgr.count(),
    );
    jsonResponse(res, 200, { ok: true, key: body.key, status: "stopped" });
  }

  const handleCanReopen = createCanReopenHandler({
    walletManager,
    jsonResponse,
    readJsonBody,
  });

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
    "POST /api/position/can-reopen": handleCanReopen,
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

/*- buildStatusPositions + _UNMANAGED_SETTINGS_KEYS live in their own
 *  module so this file stays under the 500-line cap.  Thin wrapper
 *  here injects the in-memory `_positionBotStates` map and the local
 *  `attachPoolKeys` so the helper itself stays pure (no module-level
 *  state of its own).  Re-exported via module.exports below so the
 *  existing import surface in server.js + tests is unchanged. */
const {
  buildStatusPositions: _buildStatusPositionsHelper,
} = require("./build-status-positions");

function buildStatusPositions(diskConfig, posDefaults, positionMgr, cfg) {
  return _buildStatusPositionsHelper(
    diskConfig,
    posDefaults,
    positionMgr,
    cfg,
    {
      getStates: getAllPositionBotStates,
      attachPoolKeys,
    },
  );
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
