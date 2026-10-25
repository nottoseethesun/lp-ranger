"use strict";

/**
 * @file src/lib/plain-object.js
 * @module plain-object
 * @description
 * Whether a value is a plain object: something JSON would write with
 * braces, not null and not a list. Records read from `app-data/` files
 * and answers sent to the dashboard are checked this way before their
 * fields are read, so a damaged entry is skipped rather than throwing.
 *
 * Deliberately dependency-free, so the dashboard bundle can import it
 * too. Add no `require` to this file.
 */

/**
 * @param {*} v  Any value.
 * @returns {boolean}  True for an object that is neither null nor a list.
 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

module.exports = { isPlainObject };
