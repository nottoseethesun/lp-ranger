/**
 * @file src/bot/bot-interface.js
 * @module bot-interface
 * @description
 * The bot's interface: the one module of the bot that the server loads,
 * and the one way both programs build the bot. `createBot` builds it —
 * its rpc providers, its position manager and rebalance lock — and
 * returns what a caller may ask of it: take the key it signs with
 * (`setPrivateKey`; the shared signer is built from it on first ask),
 * start and stop positions, make a move, read a position from the chain, scan the
 * wallet, save settings, report its state, and pause its price lookups.
 * Everything behind it is the bot's own, and the server reaches none of
 * it but through here. The headless bot (src/bot.js) builds its bot here
 * too, so the two programs cannot build it two ways.
 *
 * An operation that can refuse returns a result: `ok: true` with the
 * answer's fields, or `ok: false` with a reason (`invalid`, `missing`,
 * `refused`, `unavailable` or `failed`) beside them. The bot knows
 * nothing of HTTP; the server turns a reason into its status
 * (src/server/bot-result.js).
 */

"use strict";

const ethers = require("ethers");
const { log } = require("../lib/log");
const config = require("../lib/config");
const sendTx = require("./send-transaction");
const { readLog } = require("./rebalance-log");
const { createRebalanceLock } = require("./rebalance-lock");
const { createPositionManager } = require("./position-manager");
const {
  readPriceCacheSettings,
  pausePriceLookups,
  unpausePriceLookups,
} = require("./price-fetcher-gate");
const { readConfigValue, managedKeys } = require("../lib/bot-config-v2");
const {
  markStopping,
  beginWalletImport,
  endWalletImport,
  holdMoves,
  releaseMoves,
  refusalToTakeKey,
  startUpProgress,
  startUpRefusal,
} = require("./app-phase");
const {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  getAllPositionBotStates,
} = require("./position-states");
const { createAutoStartManagedPositions } = require("./auto-start");
const { guaranteedDashboardHasPolledMs } = require("./dashboard-has-polled");
const { createPositionLifecycle } = require("./position-lifecycle");
const { createManualMoves } = require("./manual-moves");
const { createWalletScan } = require("./wallet-scan");
const { createPositionViews } = require("./position-views");
const { createReloadPosition } = require("./reload-position");
const { createRescanPrices } = require("./rescan-prices");
const { createSettingsSave } = require("./settings-save");
const { createStatusReport } = require("./status-report");
const { managedPositionList } = require("./managed-positions");
const {
  underWay,
  walletChangeRefusal,
  importRefusal,
  scansEnded,
} = require("./under-way");

/**
 * Build the bot's parts: put the rpc endpoints into service, read the
 * price library's cache lifetimes, and make the rebalance lock and the
 * position manager, its count of today's rebalances per pool seeded from
 * the rebalance log and raised to the counts saved apart from it
 * (src/bot/pool-daily-counts-file.js), so a restart mid-day does not
 * reset the daily cap (which would otherwise allow
 * MAX_REBALANCES_PER_DAY × restart-count rebalances against it), not even
 * when the log lost a rebalance.
 *
 * `createBot` is its one caller in the app, so the server and the
 * headless bot build the parts one way, the count included.
 *
 * @param {{skipBackups?: boolean}} [opts]  `skipBackups` for a caller
 *   that makes the settings' safety copies itself, later (the server, once
 *   it holds its port): the price library's load then makes none.
 * @returns {{ positionMgr: object }}  The parts `botOperations` works over.
 */
function buildBotParts(opts = {}) {
  sendTx.init({ urls: config.RPC_URLS });
  readPriceCacheSettings(opts.skipBackups === true);
  const positionMgr = createPositionManager({
    rebalanceLock: createRebalanceLock(),
  });
  const entries = readLog();
  const seeded = positionMgr.seedPoolDailyCounts(entries);
  if (seeded > 0)
    log.info("[bot] Seeded %d pool rebalance(s) for today's cap", seeded);
  /*-
   *  The counts saved apart from the log hold a rebalance the log lost:
   *  one whose entry could not be written, or one in a log that was
   *  deleted (src/bot/pool-daily-counts-file.js).
   */
  const raised = positionMgr.restoreSavedPoolDailyCounts();
  if (raised > 0)
    log.info(
      "[bot] Today's saved rebalance counts raised %d pool(s)' count for today's cap",
      raised,
    );
  return { positionMgr };
}

/**
 * Build the bot.
 *
 * Run by each program's entry point as it starts, the server
 * (src/server.js) and the headless bot (src/bot.js): the bot's parts
 * (`buildBotParts`), then its operations over them.
 *
 * @param {object} opts
 * @param {object} opts.diskConfig  The loaded bot-config.json
 *   (src/lib/bot-config-v2.js): the settings the bot runs on and saves,
 *   the same object the server reads them from.
 * @param {object} opts.walletManager  The wallet store
 *   (src/lib/wallet-manager.js): the wallet the bot manages positions of.
 *   The headless bot passes one that answers `getAddress` alone, with
 *   its signer's wallet, which is all the start-up asks of it.
 * @param {boolean} [opts.skipBackups]  True when the caller makes the
 *   settings' safety copies itself (`buildBotParts`).
 * @returns {object}  The bot's operations (`botOperations`).
 */
function createBot(opts) {
  const { diskConfig, walletManager } = opts;
  const { positionMgr } = buildBotParts({ skipBackups: opts.skipBackups });
  return botOperations({ diskConfig, walletManager, positionMgr });
}

/**
 * The bot's operations over the parts `createBot` builds. A test passes
 * its own parts, stand-ins included, to drive the operations without a
 * chain or a running bot; the app's two programs use `createBot` alone.
 *
 * @param {object} parts
 * @param {object} parts.diskConfig     The loaded bot-config.json.
 * @param {object} parts.walletManager  The wallet store.
 * @param {object} parts.positionMgr    Position manager instance.
 * @param {{current: (string|null)}} [parts.privateKeyRef]  Where the key
 *   the bot signs with is kept; a new one, empty, unless given.
 * @param {Function} [parts.getAllPositionBotStates]  The per-position bot
 *   states the moves, the wallet scan, the views, Reload, Re-scan Prices,
 *   the settings save, the stop's check and the start-up read; the bot's
 *   own unless given. Manage, Stop Managing, the managed list and the
 *   status report always read the bot's own (src/bot/position-states.js).
 * @param {Function} [parts.createPerPositionBotState]  The start-up's
 *   state helpers; the bot's own unless given.
 * @param {Function} [parts.attachMultiPosDeps]
 * @param {Function} [parts.updatePositionState]
 * @param {Function} [parts.computeQuickDetails]  The position views'
 *   chain reads (src/bot/position-views.js); the real ones unless given.
 * @param {Function} [parts.computeLifetimeDetails]
 * @param {Function} [parts.setGlobalScanStatus]  Where the wallet scan
 *   keeps its progress (src/bot/wallet-scan.js); its own unless given.
 * @param {Function} [parts.getGlobalScanStatus]
 * @param {object} [parts.ethersLib]  The chain reads of Manage's pool
 *   check (src/bot/position-lifecycle.js) and of the start-up's owner
 *   and pool reads (src/bot/auto-start.js): the ethers library and the
 *   read provider thunk, with the scan-cache reader a re-open's search
 *   for an open position in its pool uses (src/bot/open-in-pool.js);
 *   the real ones unless given.
 * @param {Function} [parts.readProvider]
 * @param {Function} [parts.loadScanCache]
 * @param {Function} [parts.startBotLoop]  The loop Manage starts for a
 *   position (src/bot/bot-loop.js); the real one unless given.
 * @returns {object}  The bot's operations, listed below.
 */
function botOperations(parts) {
  const {
    diskConfig,
    walletManager,
    positionMgr,
    privateKeyRef = { current: null },
  } = parts;
  const states = parts.getAllPositionBotStates ?? getAllPositionBotStates;
  const getPrivateKey = () => privateKeyRef.current;
  const shared = {
    diskConfig,
    positionMgr,
    walletManager,
    getPrivateKey,
    getAllPositionBotStates: states,
  };

  // An `undefined` seam leaves the lifecycle's own default in place.
  const lifecycle = createPositionLifecycle({
    ...shared,
    ethersLib: parts.ethersLib,
    readProvider: parts.readProvider,
    loadScanCache: parts.loadScanCache,
    startBotLoop: parts.startBotLoop,
  });
  const moves = createManualMoves(shared);
  const walletScan = createWalletScan({
    ...shared,
    setGlobalScanStatus: parts.setGlobalScanStatus,
    getGlobalScanStatus: parts.getGlobalScanStatus,
  });
  const views = createPositionViews({
    ...shared,
    computeQuickDetails: parts.computeQuickDetails,
    computeLifetimeDetails: parts.computeLifetimeDetails,
  });
  const reloadPosition = createReloadPosition(shared);
  const rescanPrices = createRescanPrices(shared);
  const saveSettings = createSettingsSave(shared);
  const statusReport = createStatusReport({
    diskConfig,
    positionMgr,
    scanStatus: walletScan.scanStatus,
  });
  const startManagedPositions = createAutoStartManagedPositions({
    diskConfig,
    positionMgr,
    privateKeyRef,
    walletManager,
    getAllPositionBotStates: states,
    createPerPositionBotState:
      parts.createPerPositionBotState ?? createPerPositionBotState,
    attachMultiPosDeps: parts.attachMultiPosDeps ?? attachMultiPosDeps,
    updatePositionState: parts.updatePositionState ?? updatePositionState,
    readConfigValue,
    ethersLib: parts.ethersLib,
    readProvider: parts.readProvider,
  });
  /*-
   *  Why a Clear or an import is refused now: a rebalance or compound
   *  under way, or a position starting (src/bot/under-way.js).
   */
  const refusalToChangeWallet = (action) =>
    walletChangeRefusal(states(), positionMgr.startingKeys(), action);
  // Why an import is refused now: that, or what refuses any start.
  const refusalToImport = () =>
    importRefusal(states(), positionMgr.startingKeys());

  return {
    // ── The key and the start-up ──
    /** Hand the bot the key it signs with. */
    setPrivateKey: (privateKey) => {
      privateKeyRef.current = privateKey;
    },
    /** Whether the bot holds a key to sign with. */
    hasPrivateKey: () =>
      privateKeyRef.current !== null && privateKeyRef.current !== undefined,
    /**
     * Why the bot must not take a key now (src/bot/app-phase.js), or null
     * when it may: while a wallet import is under way, which takes its
     * own wallet's key, an unlock and the launch's key step are refused.
     */
    refusalToTakeKey: () => refusalToTakeKey(),
    /**
     * The start-up's progress while it is under way, `{ done, total }`,
     * else null (src/bot/app-phase.js): a Clear is refused meanwhile,
     * since the start-up would go on starting positions the Clear stops
     * (src/server/wallet-clear.js).
     */
    startUpProgress: () => startUpProgress(),
    /**
     * Why a request is refused while the start-up runs, in the
     * operator's words, `action` naming what to try again
     * (src/bot/app-phase.js). Asked only while it runs.
     */
    startUpRefusal: (action) => startUpRefusal(action),
    /**
     * Why a Clear or an import is refused now, or null: a rebalance or
     * compound under way, or a position starting (src/bot/under-way.js).
     * `action` names what to try again.
     */
    refusalToChangeWallet: (action) => refusalToChangeWallet(action),
    /**
     * Why a wallet import is refused now, or null: what refuses any start
     * (a stop, a start-up or another import under way,
     * src/bot/app-phase.js), or what refuses a Clear or an import.
     */
    refusalToImport: () => refusalToImport(),
    /**
     * How long the bot gives the dashboard to see a change
     * (src/bot/dashboard-has-polled.js): the server waits this long after
     * a launch it refuses, so open tabs show why before it exits.
     */
    guaranteedDashboardHasPolledMs: () => guaranteedDashboardHasPolledMs(),
    /**
     * The signer every position signs through, built once from the key
     * the bot holds (a random wallet in a dry run with none): its
     * provider, signer and address. The headless bot asks for it as it
     * starts, for its wallet and for its single-position mode.
     */
    sharedSigner: () =>
      positionMgr.getSharedSigner({
        privateKey: privateKeyRef.current,
        ethersLib: ethers,
        dryRun: config.DRY_RUN,
      }),
    /**
     * Once another wallet is imported, before it is unlocked, and at a
     * Clear (src/server/wallet-clear.js): halt every position at once,
     * then keep nothing of the previous wallet — its key, and the signer
     * built from it, which would otherwise sign for the new wallet's
     * positions. It waits for nothing: both are refused while a rebalance
     * or compound is under way or a position is starting
     * (`refusalToChangeWallet`), and a check still reading the chain
     * starts no move once halted (src/bot/position-manager.js
     * `haltAll`). An import's hold on every move ends here, the old
     * positions being halted. The positions' saved status is left as it
     * is, so the next unlock of their wallet starts them again.
     */
    forgetWallet: () => {
      positionMgr.haltAll();
      privateKeyRef.current = null;
      positionMgr.resetSharedSigner();
      releaseMoves();
    },
    /**
     * Start the positions saved as managed (src/bot/auto-start.js). The
     * wallet import's own closing start-up passes `{ forImport: true }`:
     * it is the one start-up that begins while an import is under way.
     */
    startManagedPositions: (opts) => startManagedPositions(opts),
    /**
     * Begin a wallet import (src/bot/app-phase.js): null when it began,
     * else why it is refused (`refusalToImport`). Until `endWalletImport`,
     * a Manage is refused and the status report says an import is under
     * way. Every rebalance and compound is held from now until
     * `forgetWallet` halts the old wallet's positions, so none begins
     * while the import saves the new wallet.
     */
    beginWalletImport: () => {
      const refusal = refusalToImport();
      if (refusal !== null) return refusal;
      beginWalletImport();
      holdMoves();
      return null;
    },
    /**
     * End the wallet import, its closing start-up included, and its hold
     * on every move, should it end before `forgetWallet` ran.
     */
    endWalletImport: () => {
      releaseMoves();
      endWalletImport();
    },
    /** How many positions' loops are running. */
    runningCount: () => positionMgr.runningCount(),

    // ── Stopping ──
    /** The app is stopping for good: nothing starts from now on. */
    markStopping: () => markStopping(),
    /** Stop every position, each once its poll has ended. */
    stopAll: () => positionMgr.stopAll(),
    /** What is still under way (src/bot/under-way.js). */
    underWay: (movesOver) => underWay(states(), movesOver),
    /** Resolves once no scan is running. */
    scansEnded: () => scansEnded(states),

    // ── Positions ──
    manage: (body) => lifecycle.manage(body),
    stopManaging: (body) => lifecycle.stopManaging(body),
    canReopen: (body) => lifecycle.canReopen(body),
    managedList: () => lifecycle.managedList(),
    /** The positions listed as managed (src/bot/managed-positions.js). */
    managedPositionList: () =>
      managedPositionList({ positionMgr, diskConfig, managedKeys }),
    requestRebalance: (positionKey) => moves.requestRebalance(positionKey),
    requestCompound: (positionKey) => moves.requestCompound(positionKey),

    // ── Reading positions and the wallet ──
    scanPositions: (readRequest) => walletScan.scanPositions(readRequest),
    refreshPositions: () => walletScan.refreshPositions(),
    cancelScan: (body) => walletScan.cancelScan(body),
    positionDetails: (body) => views.positionDetails(body),
    positionLifetime: (body) => views.positionLifetime(body),
    positionHistory: (tokenId) => views.positionHistory(tokenId),
    reloadPosition: (body) => reloadPosition(body),
    rescanPrices: (body) => rescanPrices(body),

    // ── Settings, the report, price lookups ──
    saveSettings: (body) => saveSettings(body),
    statusReport: (posDefaults) => statusReport(posDefaults),
    pausePriceLookups: (reason) => pausePriceLookups(reason),
    unpausePriceLookups: (reason) => unpausePriceLookups(reason),
  };
}

module.exports = { createBot, botOperations, buildBotParts };
