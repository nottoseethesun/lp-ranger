"use strict";

/**
 * @file src/lib/stop-on-file-problem.js
 * @module stop-on-file-problem
 * @description
 * How LP Ranger stops when it cannot read or write one of its files (the
 * user's rulings, 2026-11-27): "In the event of a file read or write
 * problem, the bot and if server, the server, should send the Telegram
 * alert and SIMPLY EXIT"; before the Telegram keys are read, the log
 * alone; "always, stop the server first, so it doesn't err out on a
 * stopped bot"; a rebalance or compound under way finishes first, and
 * nothing waits for a scan or for anyone to read a dialog.
 *
 * The first failure told (src/lib/file-problem.js) starts the stop, once:
 * 1. it says so in the log;
 * 2. it sends the Telegram alert for other errors, where the program sends
 *    one, holds the Telegram keys and has that alert on;
 * 3. it closes the server to requests, so none reaches a bot that is
 *    stopping (the server keeps its port until the exit);
 * 4. it stops the bot: nothing new starts (`markStopping`), and each
 *    position stops once its check has ended, so a rebalance or compound
 *    under way finishes; a scan still running is not waited for;
 * 5. it exits with status 1: at once when nothing could be under way, as
 *    before the bot is built, else once every position has stopped.
 * Each program hands in its own steps: the headless bot has no server to
 * close and sends no alert. A failure met while it stops is only logged.
 */

const { log } = require("./log");

/*- What the log and the alert add to the failure's own words. */
const STOPPING =
  "LP Ranger is stopping: a rebalance or compound under way finishes, " +
  "then it exits. Start it again once the file can be read and written.";

/**
 * Run one step of the stop, logging a failure of it, so the stop goes on.
 * @param {string} what  The step, for the log.
 * @param {() => *} step
 * @returns {*}  What the step answered, or undefined when it failed.
 */
function _step(what, step) {
  try {
    return step();
  } catch (err) {
    log.error("[stop] Could not %s: %s", what, err.message);
    return undefined;
  }
}

/**
 * Create the stop each program hands src/lib/file-problem.js.
 * @param {object} steps
 * @param {(words: string, detail: string) => void} steps.alert  Sends the
 *   alert for other errors, where the program sends one.
 * @param {() => void} steps.closeServer  Closes the server, where there
 *   is one.
 * @param {() => void} steps.markStopping  Makes the app stop for good.
 * @param {() => (Promise<*>|undefined)} steps.stopPositions  Stops every
 *   position once its check has ended; undefined when no bot is built yet.
 * @param {(status: number) => void} steps.exit  Ends the process.
 * @returns {(words: string, detail: string) => void}
 */
function createStopOnFileProblem({
  alert,
  closeServer,
  markStopping,
  stopPositions,
  exit,
}) {
  let started = false;
  return function stopOnFileProblem(words, detail) {
    if (started) return;
    started = true;
    log.error("[stop] %s", STOPPING);
    _step("send the alert", () => alert(`${words}\n\n${STOPPING}`, detail));
    _step("close the server", closeServer);
    _step("mark the app stopping", markStopping);
    const stopping = _step("stop the positions", stopPositions);
    if (stopping === undefined) {
      exit(1);
      return;
    }
    Promise.resolve(stopping)
      .catch((err) =>
        log.error("[stop] Stopping the positions failed: %s", err.message),
      )
      .finally(() => exit(1));
  };
}

module.exports = { createStopOnFileProblem, STOPPING };
