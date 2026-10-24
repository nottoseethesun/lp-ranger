"use strict";

/**
 * @file src/shutdown-timing.js
 * @module shutdown-timing
 * @description
 * Read how long a stop may take, for the server that stops and for
 * `npm stop`, which asks it to, and how often `npm run gentle-stop` asks
 * the server to stop once nothing is under way.
 *
 * A stop has two clocks. The server, on SIGINT or SIGTERM, begins an
 * orderly shutdown and exits by itself after `exitTimeoutMs` whether or
 * not it finished. `npm stop` sends that SIGTERM and waits; past
 * `exitTimeoutMs + stopKillMarginMs` it sends SIGKILL instead. The
 * kill is the backup, so it must always be the slower of the two: the
 * margin is added to the server's own timeout rather than configured as
 * a second, independent figure that could be set shorter.
 * `gentleStopPollMs` belongs to neither: the wait between two of the
 * stop requests gentle-stop sends, each answered with what the server's
 * stop still waits for, and how long the server has to answer each.
 *
 * All four values come from the `shutdown` group of app-runtime.json,
 * merged with any operator override, and each becomes a timer, so each
 * is checked by `src/timer-bounds.js`. An unusable value throws, naming
 * the setting: a stop that kills on the spot because a figure was
 * mistyped is worse than a stop that refuses to run.
 */

const { loadMergedDefaults } = require("./load-merged-defaults");
const { assertTimerSec } = require("./timer-bounds");

/**
 * Check one setting from the `shutdown` group as a timer delay.
 *
 * The value stands as its own default, as the aggregator's quote limit
 * does, so the ceiling that applies is the 48-hour one.
 *
 * @param {object} group  The merged `shutdown` group.
 * @param {string} key    The setting's name within it.
 * @returns {number} Milliseconds.
 * @throws {Error} When the value cannot be a timer delay.
 */
function _ms(group, key) {
  const ms = group?.[key];
  return assertTimerSec({
    sec: ms,
    key,
    defaultSec: ms,
    label: `app-runtime.json → shutdown.${key}`,
    remedy:
      "Correct it there, or in its override under " +
      "app-config/user-configurable/.",
  });
}

/**
 * Turn a `shutdown` group into the stop timings, checking each value.
 *
 * @param {object} group  The `shutdown` group of app-runtime.json.
 * @returns {{exitTimeoutMs: number, killAfterMs: number, checkIntervalMs: number, gentleStopPollMs: number}}
 *   `killAfterMs` is how long `npm stop` waits before SIGKILL, always
 *   longer than `exitTimeoutMs`.
 * @throws {Error} When a setting is unusable.
 */
function shutdownTimingsFrom(group) {
  const exitTimeoutMs = _ms(group, "exitTimeoutMs");
  return {
    exitTimeoutMs,
    killAfterMs: exitTimeoutMs + _ms(group, "stopKillMarginMs"),
    checkIntervalMs: _ms(group, "stopCheckIntervalMs"),
    gentleStopPollMs: _ms(group, "gentleStopPollMs"),
  };
}

/**
 * Read the stop timings from app-runtime.json and any operator override.
 *
 * @returns {{exitTimeoutMs: number, killAfterMs: number, checkIntervalMs: number, gentleStopPollMs: number}}
 * @throws {Error} When a setting is unusable.
 */
function readShutdownTimings() {
  return shutdownTimingsFrom(loadMergedDefaults("app-runtime.json").shutdown);
}

module.exports = { readShutdownTimings, shutdownTimingsFrom };
