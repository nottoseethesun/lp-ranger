/**
 * @file src/lib/server-positions.js
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
const { createStopManagingHandler } = require("./server-stop-managing");
const { manageRequestRefusal } = require("./manage-request-check");
const { rejectIfPoolManaged } = require("./pool-already-managed");
const { openInPool } = require("./open-in-pool");
const { positionTag } = require("./position-answer-tag");
const { isAscanRunningOnThisPosition } = require("./scan-state");
const { scanRunningRefusal } = require("./scan-refusal");
const sendTx = require("./send-transaction");
const {
  compositeKey,
  saveConfig,
  getPositionConfig,
  getOrCreatePositionConfig,
  readConfigValue,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey: migrateConfigKey,
} = require("./bot-config-v2");
const { parseCompositeKey } = require("./composite-key");
const { RECORD_POSITION_KEYS } = require("./bot-config-keys");

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
     *  src/lib/telegram-notifications/balanced-notifier.js — see CLAUDE.md "Balanced-Band Telegram
     *  Notification". */
    _lastInBand: false,
    _lastBalancedNotifyTs: 0,
    _lastBalancedPriceFetchTs: 0,
    /*-
     *  When the OOR Timeout alert last went out (process-lifetime only;
     *  not persisted). Owned by `_oorAlertDue` in src/lib/bot-cycle.js.
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

/**
 * Update per-position state and persist when needed.
 * @param {string} key          Composite key.
 * @param {object} patch        State patch from the bot loop.
 * @param {object} diskConfig   V2 disk config (mutated + saved).
 * @param {object} positionMgr  Position manager instance.
 */
/** Persist position-scoped fields from a bot state patch to disk config. */
function _persistPositionConfig(patch, diskConfig, key, dir) {
  const changed = PERSISTED_STATE_KEYS.filter((k) => patch[k] !== undefined);
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

/*- Composite key -> pool key, for Manage requests that passed the gate
 *  but whose bot loop has not finished starting.  A Set would answer
 *  "is THIS position starting"; the pool is needed too, because the
 *  one-position-per-pool gate has to see an in-flight start as holding
 *  its pool — `state.running` is not set until the loop is up, and the
 *  window between is long enough to fit a second click. */
const _starting = new Map();

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
 *  `deps._getConfig` in src/lib/bot-cycle-opts.js.  Falls back to
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

/**
 * The answer refusing a re-open retried with Manage while a scan is
 * running on the position, as a Rebalance Now is refused then
 * (src/lib/scan-state.js): the bot would make the rebalance during the scan,
 * and leave it out of the figures the scan rebuilds.
 * @param {string} key  The position's composite key.
 * @param {object} body  The Manage request.
 * @returns {object|null}  The answer's body, or null when the retry may
 *   go on.
 */
function _reopenScanRefusal(key, body) {
  if (body.forceRebalance !== true) return null;
  if (!isAscanRunningOnThisPosition(_positionBotStates.get(key))) return null;
  return {
    ok: false,
    error: scanRunningRefusal(
      "rebalance",
      "the re-open waits: click Manage again once the read finishes",
    ),
    ...positionTag(key),
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
 * @param {object} [deps.ethersLib]  Builds the contract the pool check
 *   reads; ethers itself unless a test stands in for the chain.
 * @param {Function} [deps.readProvider]  The provider that check reads
 *   through.
 * @param {Function} [deps.loadScanCache]  The wallet scan's cache reader,
 *   for the re-open check; the real one unless a test passes its own.
 * @returns {object}  Map of route key → handler.
 */
function createPositionRoutes(deps) {
  const {
    diskConfig,
    positionMgr,
    walletManager,
    getPrivateKey,
    jsonResponse,
    readJsonBody,
    /*- Injectable so the one-position-per-pool gate can be driven in a
     *  test.  A thunk, not a value: the managed read provider is not
     *  built until `sendTx.init()` has run, which is after this factory. */
    ethersLib = ethers,
    readProvider = () => sendTx.getManagedReadProvider(),
    loadScanCache,
  } = deps;

  async function handleManage(req, res) {
    const body = await readJsonBody(req);
    /*-
     *  The server runs one chain, so every position it manages is keyed
     *  on that chain; a request cannot name another.
     */
    const blockchain = config.CHAIN_NAME;
    const contract = config.POSITION_MANAGER;
    const wallet = walletManager.getAddress();
    const pk = getPrivateKey();
    const bad = manageRequestRefusal(body, wallet, pk);
    if (bad !== null) {
      jsonResponse(res, bad.status, { ok: false, error: bad.error });
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
      const scanRefusal = _reopenScanRefusal(key, body);
      if (scanRefusal !== null) {
        jsonResponse(res, 409, scanRefusal);
        return;
      }
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
        ...positionTag(key),
      });
      return;
    }
    /*- One active position per pool.  Two positions open in the same
     *  pool hold indistinguishable tokens in the same wallet, so gains
     *  moving between them cannot be attributed to either and residual
     *  coins cannot be allocated — the rule the README and User Manual
     *  state.  `key` is passed as selfKey so a rebalance, which mints a
     *  new tokenId within the same pool, cannot reject itself. */
    const provider = readProvider();
    /*- The canonical pool-key builder, bound to this wallet.  Reused
     *  rather than re-derived so the gate cannot disagree with the
     *  pool keys the status payload and daily-cap counters use. */
    const poolKeyFn = (t0, t1, f) =>
      positionMgr.poolKey(blockchain, contract, wallet, t0, t1, f);
    if (
      await rejectIfPoolManaged({
        res,
        jsonResponse,
        log: log.warn,
        key,
        tokenId: String(body.tokenId),
        chain: blockchain,
        wallet,
        positionManager: contract,
        botStates: _positionBotStates,
        provider,
        poolKeyFn,
        ethersLib,
        startingPools: _starting,
        /*- Claimed synchronously inside the gate, so the check and the
         *  claim cannot be split by another request. */
        claimPool: (pk) => _starting.set(key, pk),
        // A re-open is refused while the wallet holds an open position there.
        openInPool: (pool) =>
          openInPool({
            wallet,
            pool,
            tokenId: String(body.tokenId),
            poolKeyFn,
            provider,
            ethersLib,
            positionManager: contract,
            blockchain,
            loadCache: loadScanCache,
          }),
      })
    )
      return;

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
      /*- `liquidity` comes from the client, and BigInt() throws on
       *  anything non-numeric. An exception here escapes between the
       *  pool claim and the try/finally that releases it, leaving the
       *  pool claimed for the life of the process. Treat unusable
       *  input as "no liquidity stated", which is the same branch an
       *  absent value already takes. */
      const liq = body.liquidity;
      const usable = /^\d+$/.test(String(liq));
      posConfig.autoCompoundEnabled = !liq || !usable || BigInt(liq) > 0n;
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
    /*- Inside the try: a signer failure must release the pool claim
     *  via the finally, not strand it. */
    try {
      const shared = await positionMgr.getSharedSigner({
        privateKey: pk,
        ethersLib: ethers,
        dryRun: config.DRY_RUN,
      });
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
          ...positionTag(key),
        });
      } else {
        jsonResponse(res, 500, {
          ok: false,
          error: "Failed to start position: " + err.message,
          ...positionTag(key),
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

    /*-
     *  A re-open answers after its first rebalance, which mints a new
     *  NFT, so the answer names both keys.
     */
    jsonResponse(res, 200, {
      ok: true,
      key,
      tokenId: String(body.tokenId),
      ...positionTag(key, keyRef.current),
    });
  }

  const handleRemove = createStopManagingHandler({
    diskConfig,
    positionMgr,
    botStates: _positionBotStates,
    jsonResponse,
    readJsonBody,
  });

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
  PERSISTED_STATE_KEYS,
};
