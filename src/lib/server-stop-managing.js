"use strict";

/**
 * @file src/lib/server-stop-managing.js
 * @description `DELETE /api/position/manage`: Stop Managing. Stops the
 *   position's bot loop, takes the position off the list the next launch
 *   starts (its saved status becomes `stopped`, its other settings kept
 *   for history), and turns its auto-compound off, so a later Manage
 *   does not find it on.
 *
 *   A rebalance can move the position to a new NFT while its loop
 *   stops, since the stop waits for the check under way. The position
 *   manager moves its record's key with it, so the answer and every step
 *   after the stop use the key the position has by then, and the answer
 *   names both keys (src/lib/position-answer-tag.js).
 *
 *   Split out of `src/lib/server-positions.js`, which builds it with the
 *   other position routes through `createStopManagingHandler(deps)`.
 */

const { log } = require("./log");
const {
  getPositionConfig,
  removeManagedPosition,
  saveConfig,
} = require("./bot-config-v2");
const { positionTag } = require("./position-answer-tag");

/**
 * Build the Stop Managing route handler.
 * @param {object} deps
 * @param {object} deps.diskConfig       The loaded bot-config.json.
 * @param {object} deps.positionMgr      Position manager instance.
 * @param {Map<string, object>} deps.botStates  Per-position bot states,
 *   keyed by composite key; the stopped position's entry is dropped.
 * @param {Function} deps.jsonResponse   JSON responder.
 * @param {Function} deps.readJsonBody   JSON body reader.
 * @returns {(req, res) => Promise<void>}
 */
function createStopManagingHandler(deps) {
  const { diskConfig, positionMgr, botStates, jsonResponse, readJsonBody } =
    deps;

  return async function handleRemove(req, res) {
    const body = await readJsonBody(req);
    if (!body.key) {
      jsonResponse(res, 400, { ok: false, error: "Missing key" });
      return;
    }
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
    jsonResponse(res, 200, {
      ok: true,
      key: body.key,
      status: "stopped",
      ...positionTag(body.key, liveKey),
    });
  };
}

module.exports = { createStopManagingHandler };
