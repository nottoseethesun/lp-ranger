/**
 * @file src/bot/position-states.js
 * @module position-states
 * @description
 * The bot's state for each position it runs, in memory and keyed by
 * composite key: how a state is made, how a bot loop's patch updates it
 * and saves what must survive a restart, how a rebalance's new NFT moves
 * its key, and what each state carries from the position manager. Also
 * the bot's report of every position, for the status answer.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const { log } = require("../lib/log");
const config = require("../lib/config");
const { setCachedEpochs } = require("./epoch-cache");
const {
  compositeKey,
  saveConfig,
  getPositionConfig,
  removeManagedPosition,
  migratePositionKey: migrateConfigKey,
} = require("../lib/bot-config-v2");
const { parseCompositeKey } = require("../lib/composite-key");
const { RECORD_POSITION_KEYS } = require("../lib/bot-config-keys");
const { walletStates } = require("./deposit-attribution-inputs");
const { coinInOtherNfts } = require("./wallet-coin-share");
const { joinOrLeave, wakeOthersSharingACoin } = require("./shared-coin-wake");
const {
  buildStatusPositions: _buildStatusPositionsHelper,
} = require("./build-status-positions");

/** Per-position bot state (in-memory, keyed by composite key). */
const _positionBotStates = new Map();

/*-
 *  Bot-state fields saved to the position's config slot and read back on
 *  the next start — ONE list, used in both directions. They are the
 *  position's records (`RECORD_POSITION_KEYS`, src/lib/bot-config-keys.js),
 *  which `saveConfig` writes to the records file, apart from the settings.
 *
 *  Invariant: a field the save path writes must be one the restore path
 *  reads, and vice versa. A single list makes that structural; two copies
 *  make it a matter of remembering to edit both.
 *
 *  The lifetime deposit and its fallback flag belong here because of the
 *  gate on the lifetime scan's chain read. `_scanLifetimePoolData` skips
 *  that read only when the HODL amounts, the compound total AND the
 *  deposit total are all on disk (`lifetimeFiguresSaved`). A deposit
 *  that is never written keeps the read on, and every restart then reads
 *  the whole rebalance chain again.
 *
 *  Both directions matter. A skipped scan does not recompute the deposit,
 *  so the total must come back into memory from disk: readiness is
 *  `totalLifetimeDepositUsd > 0`, and without the restore the Syncing
 *  badge would never clear.
 */
const PERSISTED_STATE_KEYS = RECORD_POSITION_KEYS;

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
     *  src/bot/telegram-notifications/balanced-notifier.js — see CLAUDE.md "Balanced-Band Telegram
     *  Notification". */
    _lastInBand: false,
    _lastBalancedNotifyTs: 0,
    _lastBalancedPriceFetchTs: 0,
    /*-
     *  When the OOR Timeout alert last went out (process-lifetime only;
     *  not persisted). Owned by `_oorAlertDue` in src/bot/bot-cycle.js.
     */
    _lastOorAlertAt: null,
  };
  if (saved !== undefined && saved !== null) {
    for (const k of PERSISTED_STATE_KEYS) {
      if (saved[k] !== undefined && saved[k] !== null) state[k] = saved[k];
    }
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

/** Persist position-scoped fields from a bot state patch to disk config. */
function _persistPositionConfig(patch, diskConfig, key, dir) {
  const changed = PERSISTED_STATE_KEYS.filter((k) => patch[k] !== undefined);
  const needsSave = !!patch.activePositionId || changed.length > 0;
  if (!needsSave) return;
  /*-
   *  Non-lazy lookup: a slot SHOULD exist by now (Manage's `_start` in
   *  position-lifecycle.js created it before starting the bot loop).
   *  If it's missing, refuse to create one: a patch persisted under a
   *  key that has since migrated would otherwise leave a phantom entry
   *  under the stale key. Warn loudly so the caller can investigate.
   */
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

/**
 * Update per-position state and persist when needed.
 * @param {{ current: string }} keyRef  Live composite key.
 * @param {object} patch        State patch from the bot loop.
 * @param {object} diskConfig   V2 disk config (mutated + saved).
 * @param {object} positionMgr  Position manager instance.
 * @param {string} [dir]        Config folder (tests).
 */
function updatePositionState(keyRef, patch, diskConfig, positionMgr, dir) {
  const key = keyRef.current;
  let state = _positionBotStates.get(key);
  if (!state) {
    state = {};
    _positionBotStates.set(key, state);
  }
  /*- A position whose first check has saved its NFT's coins, or which
   *  stops, changes how the others divide a coin their pools share
   *  (src/bot/shared-coin-wake.js). */
  const change = joinOrLeave(state, patch);
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  if (change !== null)
    wakeOthersSharingACoin(_positionBotStates.values(), state, change);

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
  /*- The running positions of this wallet, whose deposits of a coin they
   *  share count where the coins went (src/bot/deposit-attribution.js). */
  botState._walletDepositStates = () =>
    walletStates(_positionBotStates, botState);
  /*- The other running positions whose pool contains a coin, which this
   *  position's part of the wallet's balance of it is divided beside
   *  (src/bot/wallet-coin-share.js). */
  botState._coinInOtherNfts = (coin) =>
    coinInOtherNfts(_positionBotStates.values(), botState, coin);
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
 *  module so this file stays under the 500-line cap.  This wrapper
 *  injects the in-memory `_positionBotStates` map and the local
 *  `attachPoolKeys` so the helper itself stays pure (no module-level
 *  state of its own). */
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
  PERSISTED_STATE_KEYS,
};
