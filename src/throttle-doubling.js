"use strict";

/**
 * @file src/throttle-doubling.js
 * @module throttle-doubling
 * @description
 * The three numbers that define the rebalance throttle's doubling mode,
 * held once for the bot and the dashboard alike.
 *
 * Doubling mode starts when `TRIGGER_COUNT` rebalances land within
 * `TRIGGER_WINDOW_MULTIPLE` times the minimum interval between
 * rebalances, and clears after a quiet spell of `QUIET_WINDOW_MULTIPLE`
 * times the current, already doubled, wait. `src/throttle.js` enforces
 * the rule; the dashboard shows the trigger window beside the Min Time
 * Between Rebalances setting. The Help and the User Manual describe the
 * same three numbers as the definition of the feature.
 *
 * **Deliberately dependency-free**, as `src/pool-key.js` is: the
 * dashboard bundle can only take in a module that pulls nothing
 * Node-only with it, and both tiers importing this one file is what
 * keeps the dashboard's label from drifting away from the bot's rule.
 *
 * Add no `require` to this file.
 */

/** Rebalances within the trigger window that switch doubling mode on. */
const TRIGGER_COUNT = 3;

/** The trigger window, as a multiple of the minimum interval. */
const TRIGGER_WINDOW_MULTIPLE = 4;

/** The quiet spell that clears doubling, as a multiple of the current wait. */
const QUIET_WINDOW_MULTIPLE = 4;

module.exports = {
  TRIGGER_COUNT,
  TRIGGER_WINDOW_MULTIPLE,
  QUIET_WINDOW_MULTIPLE,
};
