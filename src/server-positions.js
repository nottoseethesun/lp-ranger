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

'use strict';

const config = require('./config');
const { startBotLoop } = require('./bot-loop');
const {
  compositeKey, parseCompositeKey, saveConfig,
  getPositionConfig, readConfigValue, addManagedPosition, removeManagedPosition,
  migratePositionKey: migrateConfigKey,
} = require('./bot-config-v2');

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
    running: false, startedAt: null,
    activePosition: null,
    rebalanceCount: 0, lastRebalanceAt: null,
    rebalanceError: null, rebalancePaused: false,
    rebalanceScanComplete: false, rebalanceScanProgress: 0,
  };
  if (saved) {
    if (saved.pnlEpochs) state.pnlEpochs = saved.pnlEpochs;
    if (saved.hodlBaseline) state.hodlBaseline = saved.hodlBaseline;
    if (saved.residuals) state.residuals = saved.residuals;
    if (saved.collectedFeesUsd) state.collectedFeesUsd = saved.collectedFeesUsd;
  }
  return state;
}

/**
 * Update per-position state and persist when needed.
 * @param {string} key          Composite key.
 * @param {object} patch        State patch from the bot loop.
 * @param {object} diskConfig   V2 disk config (mutated + saved).
 * @param {object} positionMgr  Position manager instance.
 */
function updatePositionState(keyRef, patch, diskConfig, positionMgr) {
  const key = keyRef.current;
  let state = _positionBotStates.get(key);
  if (!state) { state = {}; _positionBotStates.set(key, state); }
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });

  // Persist position-specific data to v2 config when important fields change
  const shouldPersist = patch.pnlEpochs || patch.hodlBaseline || patch.residuals
    || patch.collectedFeesUsd !== undefined || patch.activePositionId;
  if (shouldPersist) {
    const pos = getPositionConfig(diskConfig, key);
    if (patch.pnlEpochs) pos.pnlEpochs = patch.pnlEpochs;
    if (patch.hodlBaseline) { pos.hodlBaseline = patch.hodlBaseline; console.log('[pos-state] Persisted hodlBaseline for %s', key); }
    if (patch.residuals) pos.residuals = patch.residuals;
    if (patch.collectedFeesUsd !== undefined) pos.collectedFeesUsd = patch.collectedFeesUsd;
    saveConfig(diskConfig);
  }

  // Handle key migration after rebalance (new tokenId) — save disk first, then memory.
  // Update keyRef.current so ALL closures (updateBotState, getConfig) use the new key.
  const parsed = parseCompositeKey(key);
  if (parsed && patch.activePositionId && String(patch.activePositionId) !== parsed.tokenId) {
    const newKey = compositeKey(parsed.blockchain, parsed.wallet, parsed.contract, String(patch.activePositionId));
    console.log('[pos-state] Key migration: %s → %s (new tokenId=%s)', key, newKey, patch.activePositionId);
    migrateConfigKey(diskConfig, key, newKey);
    saveConfig(diskConfig);
    positionMgr.migrateKey(key, newKey, String(patch.activePositionId));
    state.forceRebalance = false; state.rebalancePaused = false; state.rebalanceError = null;
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
  botState._poolKey = positionMgr.poolKey;
  botState._canRebalancePool = positionMgr.canRebalancePool;
  botState._recordPoolRebalance = positionMgr.recordPoolRebalance;
}

/**
 * Get all per-position bot states.
 * @returns {Map<string, object>}
 */
function getAllPositionBotStates() { return _positionBotStates; }

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
  const { diskConfig, positionMgr, walletManager, getPrivateKey, jsonResponse, readJsonBody } = deps;

  async function handleManage(req, res) {
    const body = await readJsonBody(req);
    if (!body.tokenId || !/^\d+$/.test(String(body.tokenId))) { jsonResponse(res, 400, { ok: false, error: 'Missing or invalid tokenId (must be numeric)' }); return; }
    const blockchain = body.blockchain || 'pulsechain';
    const contract = body.contract || config.POSITION_MANAGER;
    const wallet = walletManager.getAddress();
    if (!wallet) { jsonResponse(res, 400, { ok: false, error: 'No wallet loaded' }); return; }
    const pk = getPrivateKey();
    if (!pk) { jsonResponse(res, 400, { ok: false, error: 'No private key available' }); return; }
    const key = compositeKey(blockchain, wallet, contract, String(body.tokenId));
    console.log('[pos-route] POST /api/position/manage tokenId=%s key=%s', body.tokenId, key);

    // If already running or currently starting, skip duplicate
    const existing = positionMgr.get(key);
    if ((existing && existing.status === 'running') || _starting.has(key)) {
      addManagedPosition(diskConfig, key);
      saveConfig(diskConfig);
      console.log('[pos-route] Position #%s already running or starting — skipping', body.tokenId);
      jsonResponse(res, 200, { ok: true, key, tokenId: String(body.tokenId), alreadyRunning: true });
      return;
    }
    _starting.add(key);

    addManagedPosition(diskConfig, key);
    saveConfig(diskConfig);

    const posConfig = getPositionConfig(diskConfig, key);
    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, positionMgr);
    _positionBotStates.set(key, posBotState);

    const t0 = Date.now();
    const keyRef = { current: key };
    await positionMgr.startPosition(key, {
      tokenId: String(body.tokenId),
      startLoop: () => startBotLoop({
        privateKey: pk, dryRun: config.DRY_RUN,
        updateBotState: (patch) => updatePositionState(keyRef, patch, diskConfig, positionMgr),
        botState: posBotState, positionId: String(body.tokenId),
        getConfig: (k) => readConfigValue(diskConfig, keyRef.current, k),
      }),
      savedConfig: posConfig,
    });
    _starting.delete(key);
    console.log('[pos-route] Position #%s started in %dms (total managed: %d)', body.tokenId, Date.now() - t0, positionMgr.count());

    jsonResponse(res, 200, { ok: true, key, tokenId: String(body.tokenId) });
  }

  async function handlePause(req, res) {
    const body = await readJsonBody(req);
    if (!body.key) { jsonResponse(res, 400, { ok: false, error: 'Missing key' }); return; }
    if (!positionMgr.get(body.key)) { jsonResponse(res, 404, { ok: false, error: 'Position not found' }); return; }
    console.log('[pos-route] POST /api/position/pause key=%s', body.key);
    await positionMgr.pausePosition(body.key);
    const pos = getPositionConfig(diskConfig, body.key);
    pos.status = 'paused';
    saveConfig(diskConfig);
    console.log('[pos-route] Position paused (running: %d, total: %d)', positionMgr.runningCount(), positionMgr.count());
    jsonResponse(res, 200, { ok: true, key: body.key, status: 'paused' });
  }

  async function handleResume(req, res) {
    const body = await readJsonBody(req);
    if (!body.key) { jsonResponse(res, 400, { ok: false, error: 'Missing key' }); return; }
    const posConfig = getPositionConfig(diskConfig, body.key);
    const entry = positionMgr.get(body.key);
    if (!entry) { jsonResponse(res, 404, { ok: false, error: 'Position not found' }); return; }
    const pk = getPrivateKey();
    if (!pk) { jsonResponse(res, 400, { ok: false, error: 'No private key available' }); return; }
    console.log('[pos-route] POST /api/position/resume key=%s tokenId=%s', body.key, entry.tokenId);

    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, positionMgr);
    _positionBotStates.set(body.key, posBotState);

    const t0 = Date.now();
    const keyRef = { current: body.key };
    await positionMgr.resumePosition(body.key, () => startBotLoop({
      privateKey: pk, dryRun: config.DRY_RUN,
      updateBotState: (patch) => updatePositionState(keyRef, patch, diskConfig, positionMgr),
      botState: posBotState, positionId: entry.tokenId,
      getConfig: (k) => readConfigValue(diskConfig, keyRef.current, k),
    }));
    console.log('[pos-route] Position resumed in %dms (running: %d)', Date.now() - t0, positionMgr.runningCount());

    posConfig.status = 'running';
    saveConfig(diskConfig);
    jsonResponse(res, 200, { ok: true, key: body.key, status: 'running' });
  }

  async function handleRemove(req, res) {
    const body = await readJsonBody(req);
    if (!body.key) { jsonResponse(res, 400, { ok: false, error: 'Missing key' }); return; }
    console.log('[pos-route] DELETE /api/position/manage key=%s', body.key);
    await positionMgr.removePosition(body.key);
    removeManagedPosition(diskConfig, body.key);
    saveConfig(diskConfig);
    _positionBotStates.delete(body.key);
    console.log('[pos-route] Position removed (remaining: %d)', positionMgr.count());
    jsonResponse(res, 200, { ok: true, key: body.key, status: 'stopped' });
  }

  function handleManagedList(_req, res) {
    const all = positionMgr.getAll();
    // Attach per-position bot state summaries
    const positions = all.map((p) => {
      const bs = _positionBotStates.get(p.key);
      return { ...p, ...(bs ? { activePosition: bs.activePosition, running: bs.running } : {}) };
    });
    jsonResponse(res, 200, { ok: true, positions });
  }

  return {
    'POST /api/position/manage':  handleManage,
    'POST /api/position/pause':   handlePause,
    'POST /api/position/resume':  handleResume,
    'DELETE /api/position/manage': handleRemove,
    'GET /api/positions/managed':  handleManagedList,
  };
}

module.exports = {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  getAllPositionBotStates,
  createPositionRoutes,
};
