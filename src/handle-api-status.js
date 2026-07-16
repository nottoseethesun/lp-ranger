/**
 * @file src/handle-api-status.js
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

/**
 * Build the `GET /api/status` route handler.
 *
 * @param {object} deps
 * @param {object} deps.config           Loaded src/config.js module.
 * @param {object} deps.diskConfig       Mutable v2 disk config object.
 * @param {object} deps.positionMgr      Position-manager instance.
 * @param {object} deps.walletManager    Wallet manager instance.
 * @param {object} deps.routeHandlers    Route-handlers bag (for getPositionScanStatus).
 * @param {Function} deps.buildStatusPositions   Per-position map builder.
 * @param {Function} deps.buildGasStatusPayload  Async gas-status payload builder.
 * @param {Function} deps.actualGasCostUsd       Converter passed to gas-status.
 * @param {Function} deps.getLpProviderDisplayName  LP-provider label lookup by (factory, PM).
 * @param {Function} deps.managedKeys            Disk-config → running-keys helper.
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
    jsonResponse,
  } = deps;

  return async function handleApiStatus(_req, res) {
    const posDefaults = {
      rebalanceOutOfRangeThresholdPercent: config.REBALANCE_OOR_THRESHOLD_PCT,
      rebalanceTimeoutMin: config.REBALANCE_TIMEOUT_MIN,
      slippagePct: config.SLIPPAGE_PCT,
      checkIntervalSec: config.CHECK_INTERVAL_SEC,
      minRebalanceIntervalMin: config.MIN_REBALANCE_INTERVAL_MIN,
      maxRebalancesPerDay: config.MAX_REBALANCES_PER_DAY,
      gasStrategy: "auto",
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
        rpcUrl: config.RPC_URL,
        positionManager: config.POSITION_MANAGER,
        /*- Single source of truth for the LP-provider label is
         *  app-config/app-defaults-for-user-configurable/lp-providers.json
         *  (composite factory+positionManager-keyed map, also served
         *  by GET /api/lp-providers for the dashboard NFT panel and
         *  read by src/telegram-notifications/telegram.js for the
         *  Telegram header). Look it up here so the legacy `pmName`
         *  consumers (Activity log, alerts, baseline) stay in sync
         *  without holding a duplicate copy of the string.  Field
         *  name stays `positionManagerName` to avoid rippling the
         *  rename through every consumer in this refactor. */
        positionManagerName:
          getLpProviderDisplayName(config.FACTORY, config.POSITION_MANAGER) ||
          "",
        chainDisplayName: config.CHAIN.displayName || config.CHAIN_NAME,
        defaultSlippagePct: config.DEFAULT_SLIPPAGE_PCT,
        compoundMinFeeUsd: config.COMPOUND_MIN_FEE_USD,
        compoundDefaultThresholdUsd: config.COMPOUND_DEFAULT_THRESHOLD_USD,
        factory: config.FACTORY,
        scanTimeoutMs: config.SCAN_TIMEOUT_MS,
        /*- Dashboard poll cadence + retire-debounce window are config
         *  values so the dashboard reads them from /api/status instead
         *  of duplicating the literal.  GUARANTEED_DASHBOARD_HAS_POLLED_MS
         *  is derived from DASHBOARD_POLL_INTERVAL_MS * 2.5 in
         *  src/config.js — single source of truth.  Dashboard's post-
         *  retire Manage-button debounce reads guaranteedDashboardHasPolledMs
         *  to gate the disable window. */
        dashboardPollIntervalMs: config.DASHBOARD_POLL_INTERVAL_MS,
        guaranteedDashboardHasPolledMs:
          config.GUARANTEED_DASHBOARD_HAS_POLLED_MS,
        ...posDefaults,
        ...diskConfig.global,
        managedPositions: (() => {
          const r = positionMgr.getAll();
          const rk = new Set(r.map((p) => p.key));
          return [
            ...r,
            ...managedKeys(diskConfig)
              .filter((k) => !rk.has(k))
              .map((k) => ({
                key: k,
                tokenId: k.split("-").pop(),
                status: diskConfig.positions[k]?.status || "running",
              })),
          ];
        })(),
        poolDailyCounts: positionMgr.getPoolDailyCounts(),
        gasStatus,
      },
      positions,
    });
  };
}

module.exports = { createApiStatusHandler };
