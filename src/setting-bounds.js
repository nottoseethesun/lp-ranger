/**
 * @file src/setting-bounds.js
 * @module settingBounds
 * @description
 * The range each checked setting must fall in, read from
 * `setting-bounds.json`.
 *
 * A setting's range sits at the same path it has in its own file, so the
 * range for `bot-config-defaults.json` → `residualCleanup.delayMs` is
 * `SETTING_BOUNDS.residualCleanup.delayMs`. Whether a value lies inside a
 * range is `withinBound` in `src/range-check.js`, the one rule for it.
 *
 * Every reader of a range comes here: `src/config-bounds.js`, which
 * refuses a Bot Settings value out of range; `src/bot-config-defaults.js`,
 * which keeps the shipped default in place of an override out of range;
 * `src/timer-bounds.js`, for every setting that becomes a timer delay;
 * and `src/config.js`, which refuses at startup. The dashboard bundles the
 * same file for the figures its help quotes. One file, so the policies
 * can differ while the figures cannot.
 *
 * Read from the shipped copy only. An override under
 * `app-config/user-configurable/` is not read, because a range an
 * override could widen would bound nothing.
 */

"use strict";

const { loadShippedDefaults } = require("./load-merged-defaults");

// Every range, frozen all the way down by the loader.
const SETTING_BOUNDS = loadShippedDefaults("setting-bounds.json");

/**
 * Whether `v` is a range: an object whose only keys are `min`, `max` and
 * `integer`. A group of ranges, such as `tx`, is not one.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isRange(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => ["min", "max", "integer"].includes(k))
  );
}

/**
 * The range at a setting's path in its own file, such as `tx.deadlineSec`
 * for app-runtime.json's `tx` → `deadlineSec`, or null when it has none.
 *
 * @param {string} at  The path, its parts joined by dots.
 * @returns {{min?: number, max?: number, integer?: boolean}|null}
 */
function boundAt(at) {
  const found = at.split(".").reduce((node, k) => node?.[k], SETTING_BOUNDS);
  return isRange(found) ? found : null;
}

module.exports = { SETTING_BOUNDS, isRange, boundAt };
