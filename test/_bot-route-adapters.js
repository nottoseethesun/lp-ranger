/**
 * @file test/_bot-route-adapters.js
 * @description Test helper (not a test file). The route handlers some
 * tests were written against, rebuilt from what replaced them when the
 * server and the bot were separated: the bot's operation
 * (src/bot/*) under the server's route (src/server/position-routes.js),
 * both built from the one set of deps the test passes. Each keeps the
 * name and the `(req, res)` shape it had, so those tests still drive
 * the request end to end, answer included.
 */

"use strict";

const {
  createWalletScan,
  resolveTokenSymbol,
} = require("../src/bot/wallet-scan");
const { createReloadPosition } = require("../src/bot/reload-position");
const { createRescanPrices } = require("../src/bot/rescan-prices");
const { createStatusReport } = require("../src/bot/status-report");
const { botOperations } = require("../src/bot/bot-interface");
const {
  createPositionRoutes: positionRoutesOver,
} = require("../src/server/position-routes");

/**
 * The position routes over the bot's operations, as the server has them:
 * `botOperations` (src/bot/bot-interface.js) over the parts the test
 * passes, so Manage, Stop Managing, the re-open check and the managed
 * list run through the interface's own bindings, not around them.
 * @param {object} deps  As for `createPositionLifecycle`, with
 *   `jsonResponse` and `readJsonBody`.
 * @returns {object}  Map of route key → handler.
 */
function createPositionRoutes(deps) {
  const getPrivateKey = deps.getPrivateKey ?? (() => null);
  const bot = botOperations({
    ...deps,
    /*-
     *  The key the test's `getPrivateKey` gives, asked each time the bot
     *  reads its key. These routes never hand the bot a key, so it has no
     *  setter: one that tried would throw.
     */
    privateKeyRef: {
      get current() {
        return getPrivateKey();
      },
    },
  });
  return positionRoutesOver({ ...deps, bot });
}
const {
  createApiStatusHandler: statusRouteOver,
} = require("../src/server/handle-api-status");
const {
  createRouteHandlers: routeHandlersOver,
} = require("../src/server/server-routes");

/**
 * The server's route handlers under the names they had before the bot
 * got its interface: the server's own (src/server/server-routes.js) and
 * the position routes (src/server/position-routes.js), both over the
 * bot's operations built from the parts the test passes
 * (`botOperations`), with the wallet scan's progress
 * (`getPositionScanStatus`) and the start-up (`_autoStartManagedPositions`).
 * @param {object} deps  The parts and stand-ins `botOperations` takes,
 *   with what `createRouteHandlers` takes.
 * @returns {object}
 */
function createRouteHandlers(deps) {
  let scan = { status: "idle", progress: null };
  const bot = botOperations({
    ...deps,
    getGlobalScanStatus: () => scan,
    setGlobalScanStatus: (status, progress) => {
      scan = { status, progress: progress || null };
    },
  });
  const routes = positionRoutesOver({ ...deps, bot });
  return {
    ...routeHandlersOver({ ...deps, bot }),
    getPositionScanStatus: () => scan,
    _autoStartManagedPositions: () => bot.startManagedPositions(),
    _resolveTokenSymbol: resolveTokenSymbol,
    _handlePositionsScan: routes["POST /api/positions/scan"],
    _handlePositionsRefresh: routes["POST /api/positions/refresh"],
    _handlePositionScanCancel: routes["POST /api/position/scan-cancel"],
    _handlePositionDetails: routes["POST /api/position/details"],
    _handlePositionLifetime: routes["POST /api/position/lifetime"],
    _handlePositionReload: routes["POST /api/position/reload"],
    _handleRescanPrices: routes["POST /api/position/rescan-prices"],
  };
}

/**
 * `GET /api/status` over the bot's real report, its pieces the stand-ins
 * the test passes: `positionMgr`, `buildStatusPositions`,
 * `buildGasStatusPayload`, `actualGasCostUsd`, `primaryRouteLabel`,
 * `managedKeys`, and the wallet scan's progress from
 * `routeHandlers.getPositionScanStatus`.
 * @param {object} deps
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createApiStatusHandler(deps) {
  const statusReport = createStatusReport({
    diskConfig: deps.diskConfig,
    positionMgr: deps.positionMgr,
    scanStatus: () => deps.routeHandlers.getPositionScanStatus(),
    buildStatusPositions: deps.buildStatusPositions,
    buildGasStatusPayload: deps.buildGasStatusPayload,
    actualGasCostUsd: deps.actualGasCostUsd,
    primaryRouteLabel: deps.primaryRouteLabel,
    managedKeys: deps.managedKeys,
  });
  return statusRouteOver({ ...deps, bot: { statusReport } });
}

/**
 * The wallet scan's three routes, under the handler names they had.
 * @param {object} deps  As for `createWalletScan`, with `jsonResponse`
 *   and `readJsonBody`.
 * @returns {object}
 */
function createScanHandlers(deps) {
  const scan = createWalletScan(deps);
  const routes = positionRoutesOver({ ...deps, bot: scan });
  return {
    _handlePositionsScan: routes["POST /api/positions/scan"],
    _handlePositionsRefresh: routes["POST /api/positions/refresh"],
    _handlePositionScanCancel: routes["POST /api/position/scan-cancel"],
    resolveTokenSymbol: scan.resolveTokenSymbol,
  };
}

/**
 * Reload Current Position's route.
 * @param {object} deps  As for `createReloadPosition`, with
 *   `jsonResponse` and `readJsonBody`.
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createReloadPositionHandler(deps) {
  const bot = { reloadPosition: createReloadPosition(deps) };
  return positionRoutesOver({ ...deps, bot })["POST /api/position/reload"];
}

/**
 * Re-scan Prices' route.
 * @param {object} deps  As for `createRescanPrices`, with `jsonResponse`
 *   and `readJsonBody`.
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createRescanPricesHandler(deps) {
  const bot = { rescanPrices: createRescanPrices(deps) };
  return positionRoutesOver({ ...deps, bot })[
    "POST /api/position/rescan-prices"
  ];
}

module.exports = {
  createPositionRoutes,
  createRouteHandlers,
  createScanHandlers,
  createReloadPositionHandler,
  createRescanPricesHandler,
  createApiStatusHandler,
};
