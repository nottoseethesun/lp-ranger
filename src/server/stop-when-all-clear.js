/**
 * @file src/server/stop-when-all-clear.js
 * @module stop-when-all-clear
 * @description
 * The server's held stop, asked for by `POST /api/stop-when-all-clear`,
 * which `npm run gentle-stop` sends: a stop command the server holds
 * until nothing it has under way is left.
 *
 * The first request starts the stop at once. From then on the app is
 * stopping for good (src/bot/app-phase.js): no position starts, no bot loop
 * starts a rebalance or compound, and Reload Current Position and Re-scan
 * Prices are refused, so nothing new begins. The stop then waits for what
 * was under way: each position's poll, so a rebalance or compound in
 * progress finishes (`stopAll`); then each scan still running, so the
 * scan that follows a rebalance, starting right after it, finishes too,
 * and the next start does not find the position's figures short of that
 * rebalance. Then the server exits. What is under way is the bot's to say
 * (src/bot/under-way.js), asked through its interface.
 *
 * Deciding at the server closes the gap a separate question would leave:
 * between an answer that nothing is under way and a stop sent after it, a
 * check could begin a move. A request after the first changes nothing and
 * answers what the stop still waits for, which gentle-stop prints.
 */

"use strict";

const { log } = require("../lib/log");

/**
 * Create the held stop.
 *
 * @param {object} deps
 * @param {Function} deps.markStopping   Makes the app stop for good.
 * @param {Function} deps.notifyShutdown Sends the shutdown alert.
 * @param {Function} deps.stopAll        Stops every position, each once
 *   its poll has ended.
 * @param {Function} deps.underWay       `(movesOver) => Array<{position,
 *   activity}>`: what the bot still has under way.
 * @param {Function} deps.scansEnded     Resolves once no scan is running.
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
    const scans = deps.underWay(true);
    if (scans.length > 0)
      log.info(
        "[server] Every position has stopped; waiting for %d scan(s) to finish: %s",
        scans.length,
        scans.map((u) => u.position).join(", "),
      );
    await deps.scansEnded();
  }
  return {
    request() {
      if (!started) {
        started = true;
        const now = deps.underWay(false);
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
      return { waitingFor: deps.underWay(movesOver) };
    },
  };
}

module.exports = { createStopWhenAllClear };
