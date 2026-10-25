/**
 * @file src/server/handle-api-status.js
 * @module handle-api-status
 * @description
 * Factory for the `GET /api/status` route handler.  Extracted from
 * `server.js` to keep that file under the 500-line cap.  Pure module —
 * no module-level state; reads deps via the closure built in
 * `createApiStatusHandler({...})` exactly once at boot.
 *
 * The handler returns `{ global, positions }` where `positions` is
 * the per-key map built by `buildStatusPositions` (settings + bot
 * state + sync-complete flags for stopped slots).
 */

"use strict";

const path = require("path");
const { configuredErrorLogPath } = require("../lib/error-log");
const { getActiveLogFilePath } = require("../lib/log-file");
const { managedPositionList } = require("./position-state-routes");
const { startUpProgress } = require("../lib/app-phase");

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
 * @param {object} deps.positionMgr      Position-manager instance.
 * @param {object} deps.walletManager    Wallet manager instance.
 * @param {object} deps.routeHandlers    Route-handlers bag (for getPositionScanStatus).
 * @param {Function} deps.buildStatusPositions   Per-position map builder.
 * @param {Function} deps.buildGasStatusPayload  Async gas-status payload builder.
 * @param {Function} deps.actualGasCostUsd       Converter passed to gas-status.
 * @param {Function} deps.getLpProviderDisplayName  LP-provider label lookup by (factory, PM).
 * @param {Function} deps.managedKeys            Disk-config → running-keys helper.
 * @param {Function} deps.primaryRouteLabel      Label of the active chain's first swap route.
 * @param {Function} deps.moralisEnabledIn       Whether the stored Moralis key is used, from `global`.
 * @param {Function} deps.jsonResponse           HTTP JSON responder.
 * @returns {(req, res) => Promise<void>}  The bound route handler.
 */
function createApiStatusHandler(deps) {
  const {
    config,
    diskConfig,
    positionMgr,
    walletManager,
    routeHandlers,
    buildStatusPositions,
    buildGasStatusPayload,
    actualGasCostUsd,
    getLpProviderDisplayName,
    managedKeys,
    primaryRouteLabel,
    moralisEnabledIn,
    jsonResponse,
  } = deps;

  return async function handleApiStatus(_req, res) {
    const posDefaults = {
      rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
      rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
      minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
      maxRebalancesPerDay: config.MAX_REBALANCES_PER_DAY,
      impermanentLossGuardPct: config.IMPERMANENT_LOSS_GUARD_PCT,
    };
    const positions = buildStatusPositions(
      diskConfig,
      posDefaults,
      positionMgr,
      config,
    );
    const gasStatus = await buildGasStatusPayload({
      positionCount: positionMgr.runningCount(),
      toUsd: actualGasCostUsd,
    });
    jsonResponse(res, 200, {
      global: {
        walletAddress: walletManager.getAddress(),
        positionScan: routeHandlers.getPositionScanStatus(),
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
        /*-
         *  The "Route:" badge's text between rebalances: the
         *  aggregator's label, or the V3 router's on a chain that names
         *  no aggregator.
         */
        swapRouteLabel: primaryRouteLabel(),
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
         *  startup by GET /api/ui-defaults, before its first poll.
         *  GUARANTEED_DASHBOARD_HAS_POLLED_MS is derived from it in
         *  src/lib/config.js (times app-runtime.json →
         *  dashboard.pollsBeforeAssumedSeen), and the dashboard's
         *  post-retire Manage-button debounce reads
         *  guaranteedDashboardHasPolledMs from here to gate the disable
         *  window.
         */
        dashboardPollIntervalMs: config.DASHBOARD_POLL_INTERVAL_MS,
        guaranteedDashboardHasPolledMs:
          config.GUARANTEED_DASHBOARD_HAS_POLLED_MS,
        ...posDefaults,
        ...diskConfig.global,
        // What the server does with the key, the default included.
        moralisEnabled: moralisEnabledIn(diskConfig.global),
        managedPositions: managedPositionList({
          positionMgr,
          diskConfig,
          managedKeys,
        }),
        /*-
         *  While the start-up is starting the positions saved as managed:
         *  how many it has dealt with and how many there are, which holds
         *  the dashboard's badge at Syncing. Null at any other time.
         */
        startingManagedPositions: startUpProgress(),
        poolDailyCounts: positionMgr.getPoolDailyCounts(),
        gasStatus,
      },
      positions,
    });
  };
}

module.exports = { createApiStatusHandler };
