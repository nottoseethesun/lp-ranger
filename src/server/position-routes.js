/**
 * @file src/server/position-routes.js
 * @module position-routes
 * @description
 * The routes about positions: Manage and Stop Managing, the re-open
 * check and the managed list; Rebalance Now and Compound Now; the wallet
 * scan, its refresh and the cancel of a pool's scan; Reload Current
 * Position and Re-scan Prices; an unmanaged position's details and
 * lifetime figures, and a closed position's history. Each reads the
 * request, asks the bot through its interface (src/bot/bot-interface.js)
 * and answers with what the bot returns: through src/server/bot-result.js,
 * which turns a refusal's reason into an http status, except the history
 * route, which answers 200 with the record the bot returns.
 */

"use strict";

const { sendBotResult } = require("./bot-result");

/** The path prefix and suffix of a closed position's history route. */
const _HISTORY_PREFIX = "/api/position/";
const _HISTORY_SUFFIX = "/history";

/**
 * The NFT id a closed position's history request names, or null when the
 * request is not one: `GET /api/position/<tokenId>/history`.
 * @param {string} method
 * @param {string} url
 * @returns {string|null}
 */
function historyTokenId(method, url) {
  if (method !== "GET") return null;
  if (!url.startsWith(_HISTORY_PREFIX) || !url.endsWith(_HISTORY_SUFFIX))
    return null;
  return url.slice(_HISTORY_PREFIX.length, -_HISTORY_SUFFIX.length);
}

/**
 * Create the position routes.
 * @param {object} deps
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js).
 * @param {Function} deps.jsonResponse   JSON response helper.
 * @param {Function} deps.readJsonBody   JSON body reader.
 * @returns {object}  Map of route key → handler.
 */
function createPositionRoutes(deps) {
  const { bot, jsonResponse, readJsonBody } = deps;

  /** Answer a request whose body the bot's `operation` takes. */
  const fromBody = (operation) => async (req, res) => {
    const body = await readJsonBody(req);
    sendBotResult(jsonResponse, res, await operation(body));
  };

  /** A request body that may be empty: Rebalance Now and Compound Now. */
  async function _optionalBody(req) {
    try {
      return await readJsonBody(req);
    } catch {
      return {}; // empty body OK
    }
  }

  /** Answer a move request (Rebalance Now, Compound Now). */
  const move = (operation) => async (req, res) => {
    const body = await _optionalBody(req);
    sendBotResult(jsonResponse, res, operation(body.positionKey));
  };

  return {
    "POST /api/position/manage": fromBody((body) => bot.manage(body)),
    "DELETE /api/position/manage": fromBody((body) => bot.stopManaging(body)),
    "POST /api/position/can-reopen": fromBody((body) => bot.canReopen(body)),
    "GET /api/positions/managed": (_req, res) =>
      sendBotResult(jsonResponse, res, bot.managedList()),
    "POST /api/rebalance": move((key) => bot.requestRebalance(key)),
    "POST /api/compound": move((key) => bot.requestCompound(key)),
    "POST /api/positions/scan": async (req, res) =>
      sendBotResult(
        jsonResponse,
        res,
        await bot.scanPositions(() => readJsonBody(req)),
      ),
    "POST /api/positions/refresh": async (_req, res) =>
      sendBotResult(jsonResponse, res, await bot.refreshPositions()),
    "POST /api/position/scan-cancel": fromBody((body) => bot.cancelScan(body)),
    "POST /api/position/reload": fromBody((body) => bot.reloadPosition(body)),
    "POST /api/position/rescan-prices": fromBody((body) =>
      bot.rescanPrices(body),
    ),
    "POST /api/position/details": fromBody((body) => bot.positionDetails(body)),
    "POST /api/position/lifetime": fromBody((body) =>
      bot.positionLifetime(body),
    ),
  };
}

/**
 * Create the handler of `GET /api/position/<tokenId>/history`, a closed
 * position's history, whose path names the NFT and so cannot be a key of
 * the route table (`historyTokenId` reads it).
 * @param {object} deps
 * @param {object} deps.bot  The bot's interface: its `positionHistory`.
 * @param {Function} deps.jsonResponse   JSON response helper.
 * @returns {(tokenId: string, res: import('http').ServerResponse) =>
 *   Promise<void>}
 */
function createPositionHistoryRoute(deps) {
  const { bot, jsonResponse } = deps;
  return async (tokenId, res) =>
    jsonResponse(res, 200, await bot.positionHistory(tokenId));
}

module.exports = {
  createPositionRoutes,
  createPositionHistoryRoute,
  historyTokenId,
};
