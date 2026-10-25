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
 * managed positions one at a time. `managedPositionList` lists both, and
 * the status poll's `managedPositions` is built from it too. That list
 * also holds the positions a shutdown has just stopped, marked `stopped`,
 * so the answer counts only those marked `running`, as the dashboard does
 * with the poll's list.
 *
 * It answers 400 for a key that does not parse as a position's composite
 * key (chain-wallet-contract-tokenId). Whether anything is under way, for
 * a stop, is the held stop's answer (`POST /api/stop-when-all-clear`,
 * src/server/stop-when-all-clear.js).
 */

"use strict";

const { parseCompositeKey } = require("../lib/composite-key");

/**
 * The positions the server lists as managed: every position its manager
 * holds, each with its status, then those whose saved status is `running`
 * and whose loop has not started.
 *
 * @param {object} deps
 * @param {object} deps.positionMgr  Its `getAll()` lists the positions it
 *   holds: `running`, or `stopped` once a shutdown has stopped them.
 * @param {object} deps.diskConfig   The loaded bot-config.json.
 * @param {Function} deps.managedKeys  The keys saved as `running`.
 * @returns {Array<{key: string, tokenId: string, status: string}>}
 */
function managedPositionList({ positionMgr, diskConfig, managedKeys }) {
  const running = positionMgr.getAll();
  const live = new Set(running.map((p) => p.key));
  return [
    ...running,
    ...managedKeys(diskConfig)
      .filter((k) => !live.has(k))
      // `managedKeys` names only slots saved as running.
      .map((k) => ({ key: k, tokenId: k.split("-").pop(), status: "running" })),
  ];
}

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
 * @param {object} deps.positionMgr
 * @param {object} deps.diskConfig
 * @param {Function} deps.managedKeys
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`
 * @returns {Record<string, Function>}  Route key to handler.
 */
function createPositionStateRoutes(deps) {
  const { jsonResponse } = deps;
  return {
    "GET /api/is-position-managed": (req, res) => {
      const key = _keyOf(req);
      if (parseCompositeKey(key) === null)
        return jsonResponse(res, 400, _BAD_KEY);
      const managed = managedPositionList(deps).some(
        (p) => p.key === key && p.status === "running",
      );
      return jsonResponse(res, 200, { managed });
    },
  };
}

module.exports = { managedPositionList, createPositionStateRoutes };
