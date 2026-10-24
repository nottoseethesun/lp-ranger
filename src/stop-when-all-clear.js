/**
 * @file src/stop-when-all-clear.js
 * @module stop-when-all-clear
 * @description
 * The server's held stop, asked for by `POST /api/stop-when-all-clear`,
 * which `npm run gentle-stop` sends: a stop command the server holds
 * until nothing it has under way is left.
 *
 * The first request starts the stop at once. From then on the app is
 * stopping for good (src/app-phase.js): no position starts, no bot loop
 * starts a rebalance or compound, and Reload Current Position and Re-scan
 * Prices are refused, so nothing new begins. The stop then waits for what
 * was under way: each position's poll, so a rebalance or compound in
 * progress finishes (`stopAll`); then each scan still running, so the
 * scan that follows a rebalance, starting right after it, finishes too,
 * and the next start does not find the position's figures short of that
 * rebalance. Then the server exits.
 *
 * Deciding at the server closes the gap a separate question would leave:
 * between an answer that nothing is under way and a stop sent after it, a
 * check could begin a move. A request after the first changes nothing and
 * answers what the stop still waits for, which gentle-stop prints.
 */

"use strict";

const { log } = require("./log");
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
 * What the stop still waits for, position by position: a rebalance or
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
 * again, since a scan can end only after another has started.
 *
 * @param {Function} getStates  Each position's bot state, by key.
 * @returns {Promise<void>}
 */
async function _scansEnded(getStates) {
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

/**
 * Create the held stop.
 *
 * @param {object} deps
 * @param {Function} deps.markStopping   Makes the app stop for good.
 * @param {Function} deps.notifyShutdown Sends the shutdown alert.
 * @param {Function} deps.stopAll        Stops every position, each once
 *   its poll has ended.
 * @param {Function} deps.getStates      Each position's bot state, by key.
 * @param {Function} deps.exit           Ends the process.
 * @returns {{request: () => {waitingFor: Array<{position: string,
 *   activity: string}>}}}  `request` starts the stop the first time and
 *   answers, every time, what it still waits for.
 */
function createStopWhenAllClear(deps) {
  let started = false;
  let movesOver = false;
  async function _run() {
    deps.markStopping();
    deps.notifyShutdown();
    await deps.stopAll();
    movesOver = true;
    const scans = underWay(deps.getStates(), true);
    if (scans.length > 0)
      log.info(
        "[server] Every position has stopped; waiting for %d scan(s) to finish: %s",
        scans.length,
        scans.map((u) => u.position).join(", "),
      );
    await _scansEnded(deps.getStates);
  }
  return {
    request() {
      if (!started) {
        started = true;
        const now = underWay(deps.getStates(), false);
        log.info(
          "[server] Stop requested: stopping once nothing is under way (%s)",
          now.length === 0
            ? "nothing is"
            : now.map((u) => u.activity + " of " + u.position).join(", "),
        );
        _run()
          .catch((err) =>
            log.error("[server] The held stop failed: %s", err.message),
          )
          .finally(() => {
            log.info("[server] Nothing left under way: exiting");
            deps.exit();
          });
      }
      return { waitingFor: underWay(deps.getStates(), movesOver) };
    },
  };
}

module.exports = { createStopWhenAllClear, underWay };
