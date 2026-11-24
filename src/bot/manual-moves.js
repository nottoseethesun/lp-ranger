/**
 * @file src/bot/manual-moves.js
 * @module manual-moves
 * @description
 * Rebalance Now and Compound Now: the operator's request for a move on a
 * running position, made by that position's next poll, which the request
 * wakes at once rather than waiting for the poll's timer. Each returns a
 * result the server answers with (src/server/bot-result.js).
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const { log } = require("../lib/log");
const { emojiId } = require("./logger");
const { positionTag } = require("./position-answer-tag");
const { isAscanRunningOnThisPosition } = require("./scan-state");
const { scanRunningRefusal } = require("./scan-refusal");

/**
 * The refusal of a Rebalance Now or Compound Now while a scan is running
 * on its position (src/bot/scan-state.js). `scanInProgress` lets the
 * dashboard wait for the scan in a dialog, then offer the move again.
 * @param {string} move  "rebalance" or "compound".
 * @param {string} action  The button: "Rebalance Now" or "Compound Now".
 * @param {string} positionKey  The position the request named.
 * @returns {object}
 */
function _scanRunningRefusal(move, action, positionKey) {
  return {
    ok: false,
    reason: "refused",
    scanInProgress: true,
    error: scanRunningRefusal(move, `${action} waits until the read finishes`),
    ...positionTag(positionKey),
  };
}

/**
 * Create the two manual moves over the bot's states.
 * @param {object} deps
 * @param {Function} deps.getAllPositionBotStates  Each running position's
 *   bot state, by composite key.
 * @returns {{requestRebalance: Function, requestCompound: Function}}
 */
function createManualMoves(deps) {
  const { getAllPositionBotStates } = deps;

  /**
   * Rebalance Now on the position `positionKey` names.
   * @param {string} [positionKey]
   * @returns {object}  The result (src/server/bot-result.js).
   */
  function requestRebalance(positionKey) {
    if (!positionKey)
      return { ok: false, reason: "invalid", error: "Missing positionKey" };
    const state = getAllPositionBotStates().get(positionKey);
    if (!state || !state.running)
      return {
        ok: false,
        reason: "refused",
        error: "Position not running or syncing",
        ...positionTag(positionKey),
      };
    /*- No Rebalance Now while a scan is running on the position: the
     *  scan's end would clear the rescan request the rebalance makes, and
     *  leave its deposits and Activity Log figures out until the next
     *  start (src/bot/scan-state.js). */
    if (isAscanRunningOnThisPosition(state))
      return _scanRunningRefusal("rebalance", "Rebalance Now", positionKey);
    const tokenId = positionKey.split("-").pop();
    /*- The client no longer sends `customRangeWidthPct` in the body.
     *  Range-width override is persistent per-position config
     *  (`rebalanceRangeWidthPct` POSITION_KEY) read by the bot loop via
     *  `deps._getConfig` in src/bot/bot-cycle-opts.js.  Client sets it via
     *  the Range Width row in Bot Settings → POST /api/config. */
    log.info("[bot] Manual rebalance for %s %s", positionKey, emojiId(tokenId));
    // Asked for: no scan starts until it is made (src/bot/scan-state.js).
    state.forceRebalance = true;
    state.rebalanceInProgress = true;
    state.rebalancePaused = false;
    state.rebalanceError = null;
    /*- Wake the poll loop so the flag gets picked up on the next
     *  tick instead of waiting for the timer-driven poll (up to
     *  CHECK_INTERVAL_SEC ≈ 5 min at default).  See bot-loop.js
     *  `botState._kickPoll` for the shape. */
    state._kickPoll?.();
    return {
      ok: true,
      message: "Rebalance requested",
      ...positionTag(positionKey),
    };
  }

  /**
   * Compound Now on the position `positionKey` names.
   * @param {string} [positionKey]
   * @returns {object}  The result (src/server/bot-result.js).
   */
  function requestCompound(positionKey) {
    if (!positionKey)
      return { ok: false, reason: "invalid", error: "Missing positionKey" };
    const state = getAllPositionBotStates().get(positionKey);
    if (!state || !state.running)
      return {
        ok: false,
        reason: "refused",
        error: "Position not running or syncing",
      };
    /*- No Compound Now while a scan is running on the position: the scan
     *  rebuilds the compound list and its totals from a chain read begun
     *  before the compound, so Fees Compounded would leave it out until
     *  the next rebuild (src/bot/scan-state.js). */
    if (isAscanRunningOnThisPosition(state))
      return _scanRunningRefusal("compound", "Compound Now", positionKey);
    const tokenId = positionKey.split("-").pop();
    log.info("[bot] Manual compound for %s %s", positionKey, emojiId(tokenId));
    // Asked for: no scan starts until it is made (src/bot/scan-state.js).
    state.forceCompound = true;
    /*- Same reasoning as Rebalance Now — kick the poll so the manual
     *  Compound Now doesn't wait for the next scheduled poll. */
    state._kickPoll?.();
    return { ok: true, message: "Compound requested" };
  }

  return { requestRebalance, requestCompound };
}

module.exports = { createManualMoves };
