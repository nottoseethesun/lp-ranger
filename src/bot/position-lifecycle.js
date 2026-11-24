/**
 * @file src/bot/position-lifecycle.js
 * @module position-lifecycle
 * @description
 * Starting and stopping the positions the bot manages, one request at a
 * time: Manage (start a bot loop for a position, or re-open a closed
 * one), Stop Managing, the re-open check, and the list of managed
 * positions. Each returns a result the server answers with
 * (src/server/bot-result.js); none knows anything of HTTP.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js). The start-up of the positions saved as
 * managed is its own module (src/bot/auto-start.js).
 */

"use strict";

const { log } = require("../lib/log");
const ethers = require("ethers");
const config = require("../lib/config");
const { startBotLoop } = require("./bot-loop");
const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
} = require("./pool-state-validate");
const { manageRequestRefusal } = require("./manage-request-check");
const { refusalToStart } = require("./app-phase");
const { rejectIfPoolManaged } = require("./pool-already-managed");
const { openInPool } = require("./open-in-pool");
const { positionTag } = require("./position-answer-tag");
const { isAscanRunningOnThisPosition } = require("./scan-state");
const { scanRunningRefusal } = require("./scan-refusal");
const sendTx = require("./send-transaction");
const {
  compositeKey,
  saveConfig,
  getOrCreatePositionConfig,
  readConfigValue,
  addManagedPosition,
} = require("../lib/bot-config-v2");
const {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  getAllPositionBotStates,
  createOnRetire,
} = require("./position-states");
const { createStopManaging } = require("./stop-managing");
const { createCanReopenCheck } = require("./can-reopen");

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
 *  `deps._getConfig` in src/bot/bot-cycle-opts.js.  Falls back to
 *  `rangeMath.preserveRange()` when not set.  No longer read from the
 *  request body — the range-width modal has been migrated into Bot
 *  Settings. */
function _stampReopenFlags(posBotState, body) {
  if (body.forceRebalance !== true) return;
  posBotState.forceRebalance = true;
}

/*- Already-running re-open path: when the user comes back to Manage
 *  after a swap-abort aborted the first re-open attempt, the
 *  `existing.status === "running"` guard in `manage` would
 *  silently no-op the request.  This helper grabs the live posBotState
 *  from the per-position map and stamps `forceRebalance` (via
 *  `_stampReopenFlags`) AND clears the aborted/midway flags
 *  (`rebalancePaused`, `rebalanceFailedMidway`, `rebalanceError`) so
 *  the next poll runs a fresh rebalance.  Range width comes from
 *  persistent config (`rebalanceRangeWidthPct` POSITION_KEY) — not
 *  from the request body.
 *  Returns true if the live state was found and stamped, false
 *  otherwise (the caller logs accordingly). */
function _stampReopenFlagsOnLive(key, body) {
  if (body.forceRebalance !== true) return false;
  const live = getAllPositionBotStates().get(key);
  if (!live) return false;
  _stampReopenFlags(live, body);
  live.rebalancePaused = false;
  live.rebalanceFailedMidway = false;
  live.rebalanceError = null;
  /*- Critical: also clear `_retireImmediately`.  bot-loop.js's
   *  `_handleError` sets it after a re-open failure to trigger an
   *  immediate retire on the next bot poll.  If the user clicks
   *  Manage to retry within the ~60 s window before that poll fires,
   *  this code path (manage's already-running short-circuit)
   *  must clear the flag — otherwise drain.js's `_retireImmediately`
   *  branch fires retire BEFORE the forceRebalance can take effect,
   *  and the user's retry click is silently lost. */
  live._retireImmediately = false;
  return true;
}

/**
 * The refusal of a re-open retried with Manage while a scan is running
 * on the position, as a Rebalance Now is refused then
 * (src/bot/scan-state.js): the bot would make the rebalance during the scan,
 * and leave it out of the figures the scan rebuilds.
 * @param {string} key  The position's composite key.
 * @param {object} body  The Manage request.
 * @returns {object|null}  The refusal, or null when the retry may go on.
 */
function _reopenScanRefusal(key, body) {
  if (body.forceRebalance !== true) return null;
  if (!isAscanRunningOnThisPosition(getAllPositionBotStates().get(key)))
    return null;
  return {
    ok: false,
    reason: "refused",
    error: scanRunningRefusal(
      "rebalance",
      "the re-open waits: click Manage again once the read finishes",
    ),
    ...positionTag(key),
  };
}

/**
 * The result of a start that failed: `unavailable` with
 * `pool-info-unavailable` when the pool's state could not be read, which
 * the dashboard's `_handleManageFailure` shows in a warning modal (with
 * the raw `message` in a scrollable code block); else `failed`.
 * @param {Error} err  Why the start failed.
 * @param {string} key  The position's composite key.
 * @param {string} tokenId  The request's tokenId, as sent.
 * @returns {object}
 */
function _startFailure(err, key, tokenId) {
  const isPoolStateErr =
    err instanceof PoolStateInvalidError ||
    err instanceof PoolStateUnavailableError;
  if (isPoolStateErr)
    return {
      ok: false,
      reason: "unavailable",
      error: "pool-info-unavailable",
      message: err.message,
      tokenId,
      ...positionTag(key),
    };
  return {
    ok: false,
    reason: "failed",
    error: "Failed to start position: " + err.message,
    ...positionTag(key),
  };
}

/**
 * Create the bot's position lifecycle: Manage, Stop Managing, the
 * re-open check and the managed list.
 * @param {object} deps
 * @param {object} deps.diskConfig     V2 disk config.
 * @param {object} deps.positionMgr    Position manager instance.
 * @param {object} deps.walletManager  Wallet manager instance.
 * @param {Function} deps.getPrivateKey  Returns resolved private key.
 * @param {object} [deps.ethersLib]  Builds the contract the pool check
 *   reads; ethers itself unless a test stands in for the chain.
 * @param {Function} [deps.readProvider]  The provider that check reads
 *   through.
 * @param {Function} [deps.loadScanCache]  The wallet scan's cache reader,
 *   for the re-open check; the real one unless a test passes its own.
 * @returns {{manage: Function, stopManaging: Function,
 *   canReopen: Function, managedList: Function}}
 */
function createPositionLifecycle(deps) {
  const {
    diskConfig,
    positionMgr,
    walletManager,
    getPrivateKey,
    /*-
     *  Injectable so the one-position-per-pool gate can be driven in a
     *  test. The provider is a thunk, asked as each Manage runs rather
     *  than when this factory is built, so building the lifecycle asks
     *  nothing of the rpc layer.
     */
    ethersLib = ethers,
    readProvider = () => sendTx.getManagedReadProvider(),
    loadScanCache,
  } = deps;

  /**
   * Why a Manage that has waited must stop before its next step, or null.
   * Manage waits twice before its loop starts: on the pool check's chain
   * reads, then on the shared signer. A wallet import or a stop that
   * began meanwhile refuses it, as either would have at its start. So
   * does a key that is no longer the one it began with, as after an
   * import that began and ended while it waited. Asked after each wait,
   * so no loop starts signing with the key of a wallet the import has
   * swapped out, and no such key is left to the new wallet's positions.
   * @param {string} key  The position's composite key.
   * @param {string|null} pk  The key the request began with.
   * @returns {object|null}  The refusal (src/server/bot-result.js).
   */
  function _lateRefusal(key, pk) {
    const now = refusalToStart();
    const error =
      now ??
      (getPrivateKey() === pk
        ? null
        : "A wallet was imported while this Manage was under way. Try again.");
    if (error === null) return null;
    log.warn(
      "[pos-route] Manage refused after its wait (key=%s): %s",
      key,
      error,
    );
    return { ok: false, reason: "refused", error, ...positionTag(key) };
  }

  /**
   * The already-running short-circuit. If the request carries
   * `forceRebalance: true` (re-open retry path), stamp the flag onto
   * the live posBotState + clear the aborted/midway state
   * (rebalancePaused + rebalanceFailedMidway + rebalanceError) — the
   * user has come back via Manage to retry after fixing slippage.
   * Without this, the second click is silently dropped and the re-open
   * never retries. Returns `reopenStamped: true` so the client can
   * confirm the retry was wired through.
   * @param {string} key  The position's composite key.
   * @param {object} body  The Manage request.
   * @returns {object}  The result.
   */
  function _alreadyRunning(key, body) {
    const scanRefusal = _reopenScanRefusal(key, body);
    if (scanRefusal !== null) return scanRefusal;
    const stamped = _stampReopenFlagsOnLive(key, body);
    log.info(
      "[pos-route] Position #%s already running or starting — skipping%s",
      body.tokenId,
      stamped ? " (stamped reopen flags onto live state)" : "",
    );
    return {
      ok: true,
      key,
      tokenId: String(body.tokenId),
      alreadyRunning: true,
      reopenStamped: stamped,
      ...positionTag(key),
    };
  }

  /**
   * Manage: start a bot loop for the position the request names.
   * @param {object} body  The Manage request: `tokenId`, and optionally
   *   `contract`, `liquidity` and `forceRebalance` (a re-open).
   * @returns {Promise<object>}  The result (src/server/bot-result.js).
   */
  async function manage(body) {
    /*-
     *  The server runs one chain, so every position it manages is keyed
     *  on that chain; a request cannot name another.
     */
    const blockchain = config.CHAIN_NAME;
    const contract = config.POSITION_MANAGER;
    const wallet = walletManager.getAddress();
    const pk = getPrivateKey();
    const bad = manageRequestRefusal(body, wallet, pk);
    if (bad !== null)
      return { ok: false, reason: bad.reason, error: bad.error };
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
    if ((existing && existing.status === "running") || _starting.has(key))
      return _alreadyRunning(key, body);
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
    const refused = await rejectIfPoolManaged({
      log: log.warn,
      key,
      tokenId: String(body.tokenId),
      chain: blockchain,
      wallet,
      positionManager: contract,
      botStates: getAllPositionBotStates(),
      provider,
      poolKeyFn,
      ethersLib,
      startingPools: _starting,
      /*- Claimed synchronously inside the gate, so the check and the
       *  claim cannot be split by another request. */
      claimPool: (poolKey) => _starting.set(key, poolKey),
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
    });
    if (refused !== null) return refused;
    const late = _lateRefusal(key, pk);
    if (late !== null) {
      _starting.delete(key);
      return late;
    }
    return _start(key, body, pk);
  }

  /**
   * Start the position's bot loop, the pool already claimed for it.
   * @param {string} key  The position's composite key.
   * @param {object} body  The Manage request.
   * @param {string} pk  The key to sign with.
   * @returns {Promise<object>}  The result.
   */
  async function _start(key, body, pk) {
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
    getAllPositionBotStates().set(key, posBotState);

    /*-
     *  Roll back the in-memory state above, so a retry starts cleanly and
     *  the status report shows no phantom managed entry. A slot that held
     *  settings before keeps them, with its prior status (e.g. `stopped`):
     *  never promoted to running.
     */
    const undo = () => {
      getAllPositionBotStates().delete(key);
      if (_hadExistingConfig) posConfig.status = _prevStatus;
      else delete diskConfig.positions[key];
    };

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
      const late = _lateRefusal(key, pk);
      if (late !== null) {
        undo();
        return late;
      }
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
      undo();
      return _startFailure(err, key, body.tokenId);
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
     *  This is symmetric with `_onRetire` (which reads `keyRef.current`)
     *  and the rest of the closures threaded into `startPosition`. */
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
     *  NFT, so the result names both keys.
     */
    return {
      ok: true,
      key,
      tokenId: String(body.tokenId),
      ...positionTag(key, keyRef.current),
    };
  }

  /**
   * The managed positions, each with its bot state's summary.
   * @returns {{ok: true, positions: object[]}}
   */
  function managedList() {
    const states = getAllPositionBotStates();
    const positions = positionMgr.getAll().map((p) => {
      const bs = states.get(p.key);
      return {
        ...p,
        ...(bs
          ? { activePosition: bs.activePosition, running: bs.running }
          : {}),
      };
    });
    return { ok: true, positions };
  }

  return {
    manage,
    stopManaging: createStopManaging({
      diskConfig,
      positionMgr,
      botStates: getAllPositionBotStates(),
    }),
    canReopen: createCanReopenCheck({ walletManager }),
    managedList,
  };
}

module.exports = { createPositionLifecycle };
