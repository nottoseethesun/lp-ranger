/**
 * @file src/bot/under-way.js
 * @module under-way
 * @description
 * What the bot has under way, position by position: a rebalance or
 * compound in progress, and a scan still running. The server's held
 * stop (src/server/stop-when-all-clear.js) asks it what the stop still
 * waits for, and waits for the scans through it. A Clear and an import
 * ask it whether a move is under way or a position is starting, and are
 * refused while one is (`walletChangeRefusal`, `importRefusal`).
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const { isAscanRunningOnThisPosition } = require("./scan-state");
const { refusalToStart } = require("./app-phase");

/** A position as the stop's answer and the log name it. */
function _label(key, state) {
  const p = state?.activePosition;
  const pair =
    p?.token0Symbol && p?.token1Symbol
      ? `${p.token0Symbol}/${p.token1Symbol} `
      : "";
  const id = p?.tokenId ?? String(key).split("-").pop();
  return `${pair}NFT #${id}`;
}

/**
 * What is still under way, position by position: a rebalance or
 * compound in progress until every position's poll has ended, and a scan
 * still running.
 *
 * @param {Map<string, object>} states  Each position's bot state, by key.
 * @param {boolean} movesOver  Every position's poll has ended, so a move
 *   still marked in progress is one no poll will make.
 * @returns {Array<{position: string, activity: string}>}  `activity` is
 *   `"rebalance"`, `"compound"` or `"scan"`.
 */
function underWay(states, movesOver) {
  const out = [];
  for (const [key, st] of states) {
    const position = _label(key, st);
    if (!movesOver && st?.rebalanceInProgress === true)
      out.push({ position, activity: "rebalance" });
    if (!movesOver && st?.compoundInProgress === true)
      out.push({ position, activity: "compound" });
    if (isAscanRunningOnThisPosition(st))
      out.push({ position, activity: "scan" });
  }
  return out;
}

/**
 * Why a wallet change, a Clear or an import, is refused now, or null.
 * Each halts every position at once, waiting for nothing
 * (src/bot/position-manager.js `haltAll`), so it is refused while a
 * position has anything a halt could cut short (the user's design,
 * 2026-11-27):
 * - a rebalance or compound under way: a rebalance from the moment it
 *   holds the rebalance lock, a Rebalance Now from the moment it is
 *   asked for, and a compound from the moment it holds the lock. Each
 *   counts until its last transaction is confirmed, the swaps that
 *   spread its leftover coins included, or until it fails or is turned
 *   down, as a Rebalance Now is in a dry run;
 * - a position starting: its first check runs, and can rebalance, before
 *   its loop can be halted.
 *
 * @param {Map<string, object>} states  Each position's bot state, by key.
 * @param {string[]} startingKeys  The positions whose start is under way.
 * @param {string} action  What to try again, for the words: "Clear
 *   Wallet" or "the import".
 * @returns {string|null}
 */
function walletChangeRefusal(states, startingKeys, action) {
  const move = underWay(states, false).find((u) => u.activity !== "scan");
  if (move !== undefined) {
    const doing = move.activity === "rebalance" ? "rebalancing" : "compounding";
    return (
      `LP Ranger is ${doing} ${move.position}. ` +
      `Try ${action} again once it has finished.`
    );
  }
  if (startingKeys.length > 0) {
    const key = startingKeys[0];
    return (
      `LP Ranger is starting ${_label(key, states.get(key))}. ` +
      `Try ${action} again once it has started.`
    );
  }
  return null;
}

/**
 * Why a wallet import is refused now, or null: what refuses any start (a
 * stop, a start-up or another import under way, src/bot/app-phase.js),
 * else what refuses a Clear or an import (`walletChangeRefusal`). The
 * import route and every status answer ask it (src/bot/bot-interface.js).
 *
 * @param {Map<string, object>} states  Each position's bot state, by key.
 * @param {string[]} startingKeys  The positions whose start is under way.
 * @returns {string|null}
 */
function importRefusal(states, startingKeys) {
  return (
    refusalToStart() ?? walletChangeRefusal(states, startingKeys, "the import")
  );
}

/**
 * Wait until no scan is running: each running scan's pass, which the bot
 * loop keeps as `_scanDone`, is awaited, and the positions are looked at
 * again, since another scan can start meanwhile: one that waited for a
 * move starts when the poll that clears the move ends (src/bot/bot-loop.js).
 *
 * @param {Function} getStates  Each position's bot state, by key.
 * @returns {Promise<void>}
 */
async function scansEnded(getStates) {
  for (;;) {
    const passes = [...getStates().values()]
      .filter(
        (s) =>
          isAscanRunningOnThisPosition(s) && s._scanDone instanceof Promise,
      )
      .map((s) => s._scanDone.catch(() => {}));
    if (passes.length === 0) return;
    await Promise.all(passes);
  }
}

module.exports = {
  underWay,
  walletChangeRefusal,
  importRefusal,
  scansEnded,
};
