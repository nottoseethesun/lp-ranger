"use strict";

/**
 * @file src/price-moved-stop.js
 * @module price-moved-stop
 * @description
 * A rebalance the price outran. The price can leave the new range while a
 * rebalance is under way: the rebalancer then stops before the mint
 * (`priceVolatile`, step 6c of src/rebalancer.js), with the old position
 * already emptied and its coins swapped in the wallet.
 *
 * The bot does not try again on its own, the user's ruling (2026-10-23):
 * a rebalance made at the price then would lock in impermanent loss the
 * owner has not weighed. It holds the position for the owner instead
 * (`rebalancePaused`, with the advice as `rebalanceError`), which the
 * dashboard shows as a yellow warning (public/dashboard-alerts.js), and
 * the Rebalance Failed Telegram alert sends the same words. A Rebalance
 * Now, or a Slippage save, lets the bot go on; a position left so is
 * retired once drained for `retire.drainedAfterMs`
 * (src/bot-cycle-drain.js).
 */

const { log } = require("./log");
const config = require("./config");
const { notify } = require("./telegram-notifications/telegram");
const { duration } = require("./help-figures");

/**
 * The words for a rebalance the price outran: the dashboard's warning and
 * the Telegram alert, so the two say the same.
 * @returns {string}
 */
function priceMovedStopMessage() {
  return (
    "The price moved out of the new range while this position was " +
    "rebalancing, so LP Ranger stopped before minting the new position. " +
    "The old position is empty, and its coins are safe in the wallet. " +
    "LP Ranger will not try again on its own. Consider any impermanent " +
    "loss; if it is acceptable, click Rebalance Now. Otherwise LP Ranger " +
    "stops managing this position in " +
    duration(config.DRAINED_RETIRE_MS / 1000) +
    ", keeping its NFT, which you can manage again."
  );
}

/**
 * Hold the position for the owner after the price outran its rebalance:
 * end the rebalance, raise the hold with the advice, and send it.
 * @param {object} state  The position's bot state.
 * @param {Function|null} emit  Publishes to the dashboard.
 * @param {{tokenId?: string|number, token0Symbol?: string,
 *   token1Symbol?: string}} [notifyPos]  The position as the Telegram
 *   alert names it.
 */
function holdAfterPriceMove(state, emit, notifyPos) {
  const message = priceMovedStopMessage();
  state.rebalanceInProgress = false;
  state.rebalancePaused = true;
  state.rebalanceError = message;
  log.warn(
    "[bot] NFT #%s %s/%s: the price moved out of the new range before the mint; holding the position for the owner",
    notifyPos?.tokenId,
    notifyPos?.token0Symbol,
    notifyPos?.token1Symbol,
  );
  if (emit) emit({ rebalancePaused: true, rebalanceError: message });
  notify("rebalanceFail", { position: notifyPos, message });
}

module.exports = { holdAfterPriceMove, priceMovedStopMessage };
