/**
 * @file src/bot/status-report.js
 * @module status-report
 * @description
 * The bot's report of itself for `GET /api/status`, which the dashboard
 * polls: each position's state, the wallet's gas, the wallet scan's
 * progress, the swap route between rebalances, the managed list, the
 * start-up's progress, each pool's rebalances today, how long the bot
 * gives the dashboard to see a change, and the last failed read or write
 * of the rebalance log. The server builds the status
 * answer around it (src/server/handle-api-status.js).
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const config = require("../lib/config");
const { managedKeys: _managedKeys } = require("../lib/bot-config-v2");
const {
  buildGasStatusPayload: _buildGasStatusPayload,
} = require("./gas-monitor");
const { actualGasCostUsd: _actualGasCostUsd } = require("./bot-pnl-updater");
const { primaryRouteLabel: _primaryRouteLabel } = require("./rebalancer-swap");
const { startUpProgress, walletImportUnderWay } = require("./app-phase");
const {
  buildStatusPositions: _buildStatusPositions,
} = require("./position-states");
const { managedPositionList } = require("./managed-positions");
const { guaranteedDashboardHasPolledMs } = require("./dashboard-has-polled");
const { rebalanceLogProblem } = require("./rebalance-log");

/**
 * Create the status report.
 * @param {object} deps
 * @param {object} deps.diskConfig  The loaded bot-config.json.
 * @param {object} deps.positionMgr  Position manager instance.
 * @param {Function} deps.scanStatus  The wallet scan's progress
 *   (src/bot/wallet-scan.js).
 * @param {Function} [deps.buildStatusPositions]  The report's pieces,
 *   overridable from tests so they need not read the chain or a real
 *   bot's states; the real ones otherwise.
 * @param {Function} [deps.buildGasStatusPayload]
 * @param {Function} [deps.actualGasCostUsd]
 * @param {Function} [deps.primaryRouteLabel]
 * @param {Function} [deps.managedKeys]
 * @returns {(posDefaults: object) => Promise<object>}  The report: the
 *   `positions` map, and `gasStatus`, `positionScan`, `swapRouteLabel`,
 *   `managedPositions`, `startingManagedPositions`, `importingWallet`,
 *   `poolDailyCounts`, `guaranteedDashboardHasPolledMs` and
 *   `rebalanceLogProblem`.
 */
function createStatusReport(deps) {
  const {
    diskConfig,
    positionMgr,
    scanStatus,
    buildStatusPositions = _buildStatusPositions,
    buildGasStatusPayload = _buildGasStatusPayload,
    actualGasCostUsd = _actualGasCostUsd,
    primaryRouteLabel = _primaryRouteLabel,
    managedKeys = _managedKeys,
  } = deps;
  return async function statusReport(posDefaults) {
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
    return {
      positions,
      gasStatus,
      positionScan: scanStatus(),
      /*-
       *  The "Route:" badge's text between rebalances: the
       *  aggregator's label, or the V3 router's on a chain that names
       *  no aggregator.
       */
      swapRouteLabel: primaryRouteLabel(),
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
      /*-
       *  Whether a wallet import is under way, its closing start-up
       *  included, which also holds the badge at Syncing.
       */
      importingWallet: walletImportUnderWay(),
      poolDailyCounts: positionMgr.getPoolDailyCounts(),
      /*-
       *  How long the bot waits before it retires a position whose
       *  re-open failed (src/bot/dashboard-has-polled.js): the
       *  dashboard's Manage button and Re-scan Prices dialog keep to it.
       */
      guaranteedDashboardHasPolledMs: guaranteedDashboardHasPolledMs(),
      /*-
       *  The last failed read or write of the rebalance log since the
       *  process started, or null: the words for the operator and when,
       *  which each tab shows once (src/bot/rebalance-log.js).
       */
      rebalanceLogProblem: rebalanceLogProblem(),
    };
  };
}

module.exports = { createStatusReport };
