/**
 * @file src/bot/managed-positions.js
 * @module managed-positions
 * @description
 * The positions the bot lists as managed: every position its manager
 * holds, each with its status, then those whose saved status is
 * `running` and whose loop has not started. The status answer publishes
 * the list, and `GET /api/is-position-managed` answers from it
 * (src/server/position-state-routes.js), so both say the same.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

/**
 * The positions the bot lists as managed.
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

module.exports = { managedPositionList };
