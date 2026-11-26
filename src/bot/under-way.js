/**
 * @file src/bot/under-way.js
 * @module under-way
 * @description
 * What the bot has under way, position by position: a rebalance or
 * compound in progress, and a scan still running. The server's held
 * stop (src/server/stop-when-all-clear.js) asks it what the stop still
 * waits for, and waits for the scans through it.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const { isAscanRunningOnThisPosition } = require("./scan-state");

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

module.exports = { underWay, scansEnded };
