/**
 * @file src/server/position-state-routes.js
 * @module position-state-routes
 * @description
 * A yes-or-no question about the positions this server runs, answered
 * from the same state the status poll reports.
 *
 * `GET /api/is-position-managed?key=<position key>` says whether the
 * server manages that position. The dashboard asks it each time it puts a
 * different position on screen, so the Manage/Stop button is drawn from
 * the server's answer, not from what was on screen before. A position
 * counts as managed when its bot loop is running, or when its saved status
 * is `running` and its loop has not started yet: the server starts its
 * managed positions one at a time. The bot's managed list
 * (src/bot/managed-positions.js), asked through its interface, lists both,
 * and the status poll's `managedPositions` is that list too. It also holds
 * the positions a shutdown has just stopped, marked `stopped`, so the
 * answer counts only those marked `running`, as the dashboard does with
 * the poll's list.
 *
 * It answers 400 for a key that does not parse as a position's composite
 * key (chain-wallet-contract-tokenId). Whether anything is under way, for
 * a stop, is the held stop's answer (`POST /api/stop-when-all-clear`,
 * src/server/stop-when-all-clear.js).
 */

"use strict";

const { parseCompositeKey } = require("../lib/composite-key");

/** The `key` query parameter of a request, or null when it has none. */
function _keyOf(req) {
  return new URL(req.url, "http://localhost").searchParams.get("key");
}

// The answer for a key that names no position.
const _BAD_KEY = {
  ok: false,
  error: "key must name a position: chain-wallet-contract-tokenId",
};

/**
 * Build the route handler.
 *
 * @param {object} deps
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js):
 *   its `managedPositionList`.
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`
 * @returns {Record<string, Function>}  Route key to handler.
 */
function createPositionStateRoutes(deps) {
  const { bot, jsonResponse } = deps;
  return {
    "GET /api/is-position-managed": (req, res) => {
      const key = _keyOf(req);
      if (parseCompositeKey(key) === null)
        return jsonResponse(res, 400, _BAD_KEY);
      const managed = bot
        .managedPositionList()
        .some((p) => p.key === key && p.status === "running");
      return jsonResponse(res, 200, { managed });
    },
  };
}

module.exports = { createPositionStateRoutes };
