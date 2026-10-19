"use strict";

/**
 * @file src/range-check.js
 * @module range-check
 * @description
 * The one rule for whether a value lies inside a range from
 * `setting-bounds.json`, and the words for what a range accepts.
 *
 * A range is `{min, max, integer}`. Both ends are inclusive and either may
 * be left out; `integer` asks for a whole number. `src/setting-bounds.js`
 * loads the ranges; this module only judges a value against one.
 *
 * **Deliberately dependency-free**, as `src/pool-key.js` is: the server
 * refuses a value with this rule, and the dashboard decides with the same
 * rule whether a token's decimals could be read. The dashboard bundle can
 * only take in a module that pulls nothing Node-only with it, so keeping
 * this file free of imports is what lets one rule serve both tiers.
 *
 * Add no `require` to this file.
 */

/**
 * Whether `v` is a number inside `bound`.
 *
 * A value that is not a finite number is never inside a range, so a
 * missing setting, text, `NaN` and `Infinity` all answer false.
 *
 * @param {*} v  The value to check.
 * @param {{min?: number, max?: number, integer?: boolean}} bound
 * @returns {boolean}
 */
function withinBound(v, bound) {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (bound.integer === true && !Number.isInteger(v)) return false;
  if (typeof bound.min === "number" && v < bound.min) return false;
  if (typeof bound.max === "number" && v > bound.max) return false;
  return true;
}

/**
 * Say what a range accepts, for a message that names a refused value:
 * "a whole number from 0 to 10", "a number of at least 0.1".
 *
 * @param {{min?: number, max?: number, integer?: boolean}} bound
 * @returns {string}
 */
function boundText(bound) {
  const kind = bound.integer === true ? "a whole number" : "a number";
  const hasMin = typeof bound.min === "number";
  const hasMax = typeof bound.max === "number";
  if (hasMin && hasMax) return `${kind} from ${bound.min} to ${bound.max}`;
  if (hasMin) return `${kind} of at least ${bound.min}`;
  if (hasMax) return `${kind} of at most ${bound.max}`;
  return kind;
}

module.exports = { withinBound, boundText };
