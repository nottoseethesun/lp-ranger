/**
 * @file src/server/handle-api-status.js
 * @module handle-api-status
 * @description
 * Factory for the `GET /api/status` route handler.  Extracted from
 * `server.js` to keep that file under the 500-line cap.  Pure module —
 * no module-level state; reads deps via the closure built in
 * `createApiStatusHandler({...})` exactly once at boot, which also holds
 * the tracker of the server's wallet changes (src/server/wallet-change.js).
 *
 * The handler returns `{ global, positions }`. What the bot knows of
 * itself, the `positions` map among it (settings + bot state +
 * sync-complete flags for stopped slots), comes from its report
 * (src/bot/status-report.js), asked through its interface. The rest is the
 * server's own: the wallet it holds, whether it holds its key, why a Clear
 * or an import would be refused now, and why the server refused to start,
 * while it waits to exit; the install's settings; and where it logs.
 */

"use strict";

const path = require("path");
const { configuredErrorLogPath } = require("../lib/error-log");
const { readUiDefaults } = require("../lib/ui-defaults");
const { getActiveLogFilePath } = require("../lib/log-file");
const { createWalletChangeTracker } = require("./wallet-change");
const { refusalToClear } = require("./wallet-clear");

/**
 * The file the server is logging to, relative to where it runs, or null
 * while logging to a file is off: the Manage tooltip of a failed re-open
 * points there for the details, and to the terminal otherwise.
 */
function _logFileForDisplay() {
  const abs = getActiveLogFilePath();
  return abs === null ? null : path.relative(process.cwd(), abs);
}

/**
 * Build the `GET /api/status` route handler.
 *
 * @param {object} deps
 * @param {object} deps.config           Loaded src/lib/config.js module.
 * @param {object} deps.diskConfig       Mutable v2 disk config object.
 * @param {object} deps.walletManager    Wallet manager instance.
 * @param {{inUse: Function}} deps.walletInUse  Whether an unlock, a
 *   Reveal Key or the launch's key step is using the wallet
 *   (src/server/wallet-in-use.js).
 * @param {() => (string|null)} deps.startRefusal  Why the launch was
 *   refused, while the server waits to exit (src/server/server-routes.js).
 * @param {object} deps.bot              The bot's interface
 *   (src/bot/bot-interface.js): its `statusReport`, whether it holds a
 *   key (`hasPrivateKey`), and why a Clear or an import would be refused
 *   now (`refusalToTakeKey`, `startUpProgress`, `startUpRefusal`,
 *   `refusalToChangeWallet`, `refusalToImport`).
 * @param {Function} deps.getLpProviderDisplayName  LP-provider label lookup by (factory, PM).
 * @param {Function} deps.moralisEnabledIn       Whether the stored Moralis key is used, from `global`.
 * @param {Function} deps.jsonResponse           HTTP JSON responder.
 * @returns {(req, res) => Promise<void>}  The bound route handler.
 */
function createApiStatusHandler(deps) {
  const {
    config,
    diskConfig,
    walletManager,
    walletInUse,
    startRefusal,
    bot,
    getLpProviderDisplayName,
    moralisEnabledIn,
    jsonResponse,
  } = deps;
  const walletChange = createWalletChangeTracker();

  return async function handleApiStatus(_req, res) {
    const posDefaults = {
      rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
      rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
      minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
      maxRebalancesPerDay: config.MAX_REBALANCES_PER_DAY,
      impermanentLossGuardPct: config.IMPERMANENT_LOSS_GUARD_PCT,
    };
    const report = await bot.statusReport(posDefaults);
    const walletAddress = walletManager.getAddress();
    const walletJustChanged = walletChange.walletJustChanged(walletAddress);
    jsonResponse(res, 200, {
      global: {
        walletAddress,
        /*-
         *  Set once a wallet has replaced another, and kept until the
         *  next change: a tab still on an older wallet reloads, once
         *  `importingWallet` is false (src/server/wallet-change.js).
         */
        walletJustChanged,
        /*-
         *  Whether the server holds a wallet and its key. A page that
         *  showed the wallet locked as it loaded, its Unlock dialog open
         *  or View-Only, shows it unlocked once this is true and
         *  `walletAddress` names the page's own wallet: the server can
         *  take the key a moment after the page loaded, as a launch with
         *  WALLET_PASSWORD does (src/client/web/js/dashboard-wallet.js).
         */
        walletUnlocked: walletManager.hasWallet() && bot.hasPrivateKey(),
        /*-
         *  Why a Clear (`DELETE /api/wallet`) would be refused now, or
         *  null: an unlock, a Reveal Key, the launch's key step, a wallet
         *  import, the start-up of the saved positions, a rebalance or
         *  compound is under way, or a position is starting, or the
         *  server, having refused to start, waits to exit. Every tab
         *  disables Clear Wallet meanwhile, this the reason it shows
         *  (src/server/wallet-clear.js).
         */
        clearWalletRefusal: refusalToClear(walletInUse, bot, startRefusal()),
        /*-
         *  Why a wallet import (`POST /api/wallet`) would be refused now,
         *  or null: a stop, a start-up or another import under way, or a
         *  rebalance or compound under way or a position starting
         *  (src/bot/bot-interface.js `refusalToImport`). Every tab
         *  disables Wallet Setup's Import Wallet buttons meanwhile, this
         *  the reason they show.
         */
        importWalletRefusal: bot.refusalToImport(),
        /*-
         *  Why the server refused to start and is about to exit, or null:
         *  each open tab shows it in a dialog, which stays once the server
         *  has gone (src/server/server-routes.js `_refuseLaunch`).
         */
        startRefusal: startRefusal(),
        positionScan: report.positionScan,
        port: config.PORT,
        host: config.HOST,
        rpcUrl: config.RPC_URLS[0],
        /*- Single source of truth for the LP-provider label is
         *  app-config/app-defaults-for-user-configurable/lp-providers.json
         *  (composite factory+positionManager-keyed map, also served
         *  by GET /api/lp-providers for the dashboard NFT panel and
         *  read by src/lib/telegram-notifications/telegram.js for the
         *  Telegram header). Look it up here so the legacy `pmName`
         *  consumers (Activity log, alerts, baseline) stay in sync
         *  without holding a duplicate copy of the string.  Field
         *  name stays `positionManagerName` to avoid rippling the
         *  rename through every consumer in this refactor. */
        positionManagerName:
          getLpProviderDisplayName(config.FACTORY, config.POSITION_MANAGER) ||
          "",
        chainDisplayName: config.CHAIN.displayName,
        /*- Canonical chain id (KEY of chains.json, e.g. "pulsechain").
         *  Distinct from chainDisplayName ("PulseChain") — clients use
         *  the id for URL slugs, lookups, and comparisons; the display
         *  name is user-facing text only (locale-dependent).  See
         *  feedback in lp-providers about ID-vs-displayName. */
        chainId: config.CHAIN_NAME,
        swapRouteLabel: report.swapRouteLabel,
        compoundMinFeeUsd: config.COMPOUND_MIN_FEE_USD,
        compoundDefaultThresholdUsd: config.COMPOUND_DEFAULT_THRESHOLD_USD,
        rescanPricesTimeoutMs: config.RESCAN_PRICES_TIMEOUT_MS,
        // logging.json → errorLogPath, for the Reload Current Position dialog.
        errorLogPath: configuredErrorLogPath(),
        logFilePath: _logFileForDisplay(),
        /*-
         *  Dashboard poll cadence + retire-debounce window. The cadence
         *  is ui-defaults_non-layout_for-server-up-scenario.json →
         *  dashboardPollIntervalMs, which the dashboard is sent at
         *  startup by GET /api/ui-defaults, before its first poll. The
         *  window is the bot's (its report, from
         *  src/bot/dashboard-has-polled.js: the cadence times
         *  app-runtime.json → dashboard.pollsBeforeAssumedSeen), and the
         *  dashboard's post-retire Manage-button debounce reads it from
         *  here to gate the disable window.
         */
        dashboardPollIntervalMs: readUiDefaults().dashboardPollIntervalMs,
        guaranteedDashboardHasPolledMs: report.guaranteedDashboardHasPolledMs,
        ...posDefaults,
        ...diskConfig.global,
        // What the server does with the key, the default included.
        moralisEnabled: moralisEnabledIn(diskConfig.global),
        managedPositions: report.managedPositions,
        startingManagedPositions: report.startingManagedPositions,
        importingWallet: report.importingWallet,
        poolDailyCounts: report.poolDailyCounts,
        gasStatus: report.gasStatus,
      },
      positions: report.positions,
    });
  };
}

module.exports = { createApiStatusHandler };
