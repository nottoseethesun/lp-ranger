/**
 * @file src/lib/shared-coin-wake.js
 * @module shared-coin-wake
 * @description
 * When a running managed position finishes its first check, or stops, each
 * other running position whose pool contains one of its coins is checked
 * again at once.
 *
 * A position's Wallet Residual (Pool) line divides the wallet's balance of
 * a coin between the running positions whose pool contains it, by the
 * amount of the coin in each one's NFT (src/lib/wallet-coin-share.js). A
 * position counts for the others from the end of its first check, when its
 * state first carries the coins its NFT contains (`positionStats`), until
 * its state's `running` turns false. The others work their division out at
 * their own checks, a poll interval apart, so without the wake-up each
 * would divide by the positions as they were before, until its next check.
 *
 * src/lib/server-positions.js asks `joinOrLeave` before it applies an
 * update to a position's state, and calls `wakeOthersSharingACoin` after.
 * The wake-up is the one Rebalance Now uses (`_kickPoll`,
 * src/lib/bot-loop.js): it starts a check on a timer, or, when a check is
 * under way, right after it. A position whose scan is running is left
 * alone, since the scan pass ends with a check of its own, and nothing is
 * woken while the app itself is stopping (src/lib/app-phase.js), since
 * every position stops then.
 */

"use strict";

const { log } = require("./log");
const { emojiId } = require("./logger");
const { isStopping } = require("./app-phase");
const { isAscanRunningOnThisPosition } = require("./scan-state");

/**
 * Whether an update makes a position join the others' division of its
 * coins, its first check having saved the coins its NFT contains, or leave
 * it, by stopping.
 *
 * @param {object} state  The position's bot state, before the update.
 * @param {object} patch  The update.
 * @returns {"joins"|"leaves"|null}
 */
function joinOrLeave(state, patch) {
  if (patch.positionStats !== undefined && state.positionStats === undefined)
    return "joins";
  if (patch.running === false && state.running === true) return "leaves";
  return null;
}

/**
 * The coins of a position's pool, lower-cased, with each one's symbol.
 * @param {object} state  A position's bot state.
 * @returns {Array<{coin: string, symbol: string}>}
 */
function _coinsOf(state) {
  const ap = state?.activePosition;
  if (!ap) return [];
  return [
    { coin: ap.token0, symbol: ap.token0Symbol },
    { coin: ap.token1, symbol: ap.token1Symbol },
  ]
    .filter((c) => typeof c.coin === "string")
    .map((c) => ({ coin: c.coin.toLowerCase(), symbol: c.symbol ?? c.coin }));
}

/**
 * A position's pool and NFT, as the log names them: "PulseX/WPLS NFT
 * #167040" and the NFT's emoji.
 * @param {object} state  A position's bot state.
 * @returns {string}
 */
function _named(state) {
  const ap = state.activePosition ?? {};
  const id = String(ap.tokenId ?? "?");
  return `${ap.token0Symbol ?? "?"}/${ap.token1Symbol ?? "?"} NFT #${id} ${emojiId(id)}`;
}

/**
 * Check again at once each other running position whose pool contains one
 * of the coins of the pool of the position that joined or left.
 *
 * @param {Iterable<object>} states  Every position's bot state.
 * @param {object} state  The position that joined or left.
 * @param {"joins"|"leaves"} change  From `joinOrLeave`.
 * @returns {number}  How many positions were woken.
 */
function wakeOthersSharingACoin(states, state, change) {
  if (isStopping()) return 0;
  const coins = _coinsOf(state);
  let woken = 0;
  for (const s of states) {
    if (s === state || s.running !== true) continue;
    if (typeof s._kickPoll !== "function") continue;
    if (isAscanRunningOnThisPosition(s)) continue;
    const shared = coins.filter((c) =>
      _coinsOf(s).some((o) => o.coin === c.coin),
    );
    if (shared.length === 0) continue;
    log.info(
      "[shared-coin] %s %s; checking %s again now, since its pool also contains %s",
      _named(state),
      change === "joins" ? "finished its first check" : "stopped",
      _named(s),
      shared.map((c) => c.symbol).join(" and "),
    );
    s._kickPoll();
    woken += 1;
  }
  return woken;
}

module.exports = { joinOrLeave, wakeOthersSharingACoin };
