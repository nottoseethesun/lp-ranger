/**
 * @file src/position-state-routes.js
 * @module position-state-routes
 * @description
 * Two yes-or-no questions about the positions this server runs, each
 * answered from the same state the status poll reports.
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
 * `GET /api/is-position-being-adjusted` says whether a rebalance or a
 * compound is under way, for the position `?key=` names or, without a key,
 * for any position. Mission Control shows the same two flags, and
 * `npm run gentle-stop` asks before stopping the server, so that a stop
 * need not cut a rebalance off halfway.
 *
 * Both answer 400 for a key that does not parse as a position's composite
 * key (chain-wallet-contract-tokenId).
 */

"use strict";

const { parseCompositeKey } = require("./composite-key");

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

/** Whether a position's state shows a rebalance or a compound under way. */
function _adjusting(state) {
  return (
    state?.rebalanceInProgress === true || state?.compoundInProgress === true
  );
}

// The answer for a key that names no position.
const _BAD_KEY = {
  ok: false,
  error: "key must name a position: chain-wallet-contract-tokenId",
};

/**
 * Build the two route handlers.
 *
 * @param {object} deps
 * @param {object} deps.positionMgr
 * @param {object} deps.diskConfig
 * @param {Function} deps.managedKeys
 * @param {Function} deps.getAllPositionBotStates  The per-position states,
 *   a Map keyed by composite key.
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`
 * @returns {Record<string, Function>}  Route key to handler.
 */
function createPositionStateRoutes(deps) {
  const { getAllPositionBotStates, jsonResponse } = deps;
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
    "GET /api/is-position-being-adjusted": (req, res) => {
      const key = _keyOf(req);
      const states = getAllPositionBotStates();
      if (key === null) {
        const adjusting = [...states.values()].some(_adjusting);
        return jsonResponse(res, 200, { adjusting });
      }
      if (parseCompositeKey(key) === null)
        return jsonResponse(res, 400, _BAD_KEY);
      return jsonResponse(res, 200, { adjusting: _adjusting(states.get(key)) });
    },
  };
}

module.exports = { managedPositionList, createPositionStateRoutes };
