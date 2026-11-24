"use strict";

/**
 * @file src/bot/stop-managing.js
 * @description Stop Managing (`DELETE /api/position/manage`), the bot's
 *   part. Stops the position's bot loop, takes the position off the list
 *   the next launch starts (its saved status becomes `stopped`, its other
 *   settings kept for history), and turns its auto-compound off, so a
 *   later Manage does not find it on.
 *   A rebalance can move the position to a new NFT while its loop
 *   stops, since the stop waits for the check under way. The position
 *   manager moves its record's key with it, so the result and every step
 *   after the stop use the key the position has by then, and the result
 *   names both keys (src/bot/position-answer-tag.js).
 *   Built by the bot's position lifecycle (src/bot/position-lifecycle.js);
 *   the server answers with what it returns (src/server/bot-result.js).
 */

const { log } = require("../lib/log");
const {
  getPositionConfig,
  removeManagedPosition,
  saveConfig,
} = require("../lib/bot-config-v2");
const { positionTag } = require("./position-answer-tag");

/**
 * Build Stop Managing.
 * @param {object} deps
 * @param {object} deps.diskConfig       The loaded bot-config.json.
 * @param {object} deps.positionMgr      Position manager instance.
 * @param {Map<string, object>} deps.botStates  Per-position bot states,
 *   keyed by composite key; the stopped position's entry is dropped.
 * @returns {(body: object) => Promise<object>}  Stops the position the
 *   request's `key` names, and returns the result (src/server/bot-result.js).
 */
function createStopManaging(deps) {
  const { diskConfig, positionMgr, botStates } = deps;

  return async function stopManaging(body) {
    if (!body.key)
      return { ok: false, reason: "invalid", error: "Missing key" };
    log.info("[pos-route] DELETE /api/position/manage key=%s", body.key);
    /*-
     *  The record is taken before the stop's wait, since a rebalance
     *  during that wait moves its key in place: read afterwards, the
     *  record gives the key the position has by then.
     */
    const entry = positionMgr.get(body.key) || null;
    try {
      await positionMgr.removePosition(body.key);
    } catch (err) {
      log.error(
        "[pos-route] Failed to remove position %s: %s\n%s",
        body.key,
        err.message,
        err.stack,
      );
    }
    const liveKey = entry?.key || body.key;
    removeManagedPosition(diskConfig, liveKey);
    // Auto-compound off, so it does not come back on with the next Manage.
    const posRef = getPositionConfig(diskConfig, liveKey);
    if (posRef) posRef.autoCompoundEnabled = false;
    saveConfig(diskConfig);
    botStates.delete(liveKey);
    log.info(
      "[pos-route] Position removed (remaining: %d)",
      positionMgr.count(),
    );
    return {
      ok: true,
      key: body.key,
      status: "stopped",
      ...positionTag(body.key, liveKey),
    };
  };
}

module.exports = { createStopManaging };
