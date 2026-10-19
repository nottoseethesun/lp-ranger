"use strict";

/**
 * @file src/settings-schema-parts.js
 * @module settings-schema-parts
 * @description
 * The pieces each settings file's JSON Schema is built from, and the
 * words a refusal by one uses.
 *
 * A file's schema (src/settings-file-rules.js) is groups of settings,
 * each naming every key it takes and refusing any other (`group`), or
 * entries under names the file chooses, such as its chains (`named`).
 * A value in one is held to its range in setting-bounds.json, found by
 * its path in its file (`ranged`), to the timer rule of
 * src/timer-bounds.js (`timer`), or to a kind of value from
 * src/value-kinds.js (`K`). Every piece carries, as its `description`,
 * what a value there must be.
 *
 * Ajv reports each value at fault as an error at a JSON pointer;
 * `problemsFromErrors` turns those into one line for each value, naming
 * the file and the setting's path in it: "app-runtime.json →
 * tx.deadlineSec must be a whole number from 300 to 3600; it is 50".
 * bot-config.json's schema (src/bot-config-checks.js) and the Telegram
 * route's check of the alerts chosen use the same words.
 */

const { boundAt } = require("./setting-bounds");
const { boundText } = require("./range-check");
const { timerRange } = require("./timer-bounds");
const { KINDS } = require("./value-kinds");

/** Each kind's schema, by the kind's name. */
const K = Object.freeze(
  Object.fromEntries(Object.entries(KINDS).map(([n, k]) => [n, k.schema])),
);

const _GROUP = "a group of settings, as shipped";

/**
 * A group of settings: these keys, every one required, and no others.
 *
 * @param {object} properties  Each key's schema.
 * @returns {object}
 */
function group(properties) {
  return {
    type: "object",
    description: _GROUP,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * Entries under names the file chooses, such as its chains.
 *
 * @param {object} entry  Each entry's schema.
 * @param {object} [names]  The schema each name must meet.
 * @returns {object}
 */
function named(entry, names) {
  return {
    type: "object",
    description: _GROUP,
    ...(names === undefined ? {} : { propertyNames: names }),
    additionalProperties: entry,
  };
}

/**
 * A number held to a range from setting-bounds.json.
 *
 * @param {{min?: number, max?: number, integer?: boolean}} bound
 * @returns {object}
 */
function inRange(bound) {
  return {
    type: bound.integer === true ? "integer" : "number",
    ...(typeof bound.min === "number" ? { minimum: bound.min } : {}),
    ...(typeof bound.max === "number" ? { maximum: bound.max } : {}),
    description: boundText(bound),
  };
}

/**
 * A value held to its range in setting-bounds.json.
 *
 * @param {string} at  The value's path in its own file, its parts joined
 *   by dots, where setting-bounds.json keeps its range.
 * @returns {object}
 * @throws {Error} When setting-bounds.json has no range there.
 */
function ranged(at) {
  const bound = boundAt(at);
  if (bound === null)
    throw new Error(`setting-bounds.json has no range at ${at}`);
  return inRange(bound);
}

/**
 * Several values of one group, each held to its range.
 *
 * @param {string[]} names  Their keys in the group.
 * @param {string} [prefix]  The group's path, ending in a dot.
 * @returns {object}  Each key's schema.
 */
function rangedEach(names, prefix = "") {
  return Object.fromEntries(names.map((n) => [n, ranged(`${prefix}${n}`)]));
}

/**
 * A value that becomes a timer delay, held to the timer rule.
 *
 * @param {string} key  The name the app checks it by, which selects any
 *   range of its own in setting-bounds.json → timers.
 * @param {number} [shipped]  The value as shipped, which sets its
 *   ceiling; left out for a value with none, such as a timer of a chain
 *   an operator adds.
 * @returns {object}
 * @throws {Error} When the shipped value is not a number.
 */
function timer(key, shipped) {
  if (shipped !== undefined && !Number.isFinite(shipped))
    throw new Error(`The shipped value of ${key} is not a number`);
  const { min, max, unit } = timerRange({ key, defaultSec: shipped });
  return {
    type: "integer",
    minimum: min,
    maximum: max,
    description: `a whole number of ${unit} from ${min} to ${max}`,
  };
}

/**
 * A list of at least one entry.
 *
 * @param {object} item  Each entry's schema.
 * @param {string} what  What the list must be.
 * @returns {object}
 */
function listOf(item, what) {
  return { type: "array", minItems: 1, items: item, description: what };
}

/**
 * A JSON pointer as the path a refusal names: `/pulsechain/rpc/urls/0`
 * as `pulsechain.rpc.urls[0]`.
 */
function _dotted(pointer) {
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((at, p) => {
      if (/^[0-9]+$/.test(p)) return `${at}[${p}]`;
      return at === "" ? p : `${at}.${p}`;
    }, "");
}

const _under = (at, key) => (at === "" ? key : `${at}.${key}`);

/** One error's place, and the words for it. */
function _refusal(file, e) {
  const at = _dotted(e.instancePath);
  if (e.keyword === "additionalProperties") {
    const key = _under(at, e.params.additionalProperty);
    return [key, `${file} → ${key} is not a setting LP Ranger reads`];
  }
  if (e.keyword === "required") {
    const key = _under(at, e.params.missingProperty);
    return [key, `${file} → ${key} is missing`];
  }
  if (e.keyword === "propertyNames") {
    const key = _under(at, e.params.propertyName);
    const what = e.parentSchema.propertyNames.description;
    return [key, `${file} → ${key} must be ${what}`];
  }
  // The whole file, or the whole value a route was sent.
  const place = at === "" ? file : `${file} → ${at}`;
  /*-
   *  A key that belongs in another file: its schema refuses any value,
   *  and its description says where the key belongs instead.
   */
  if (e.keyword === "not")
    return [at, `${place} ${e.parentSchema.description}`];
  const what = e.parentSchema.description;
  return [at, `${place} must be ${what}; it is ${JSON.stringify(e.data)}`];
}

/**
 * Every problem Ajv found in one file, one for each value at fault, in
 * the words its schema carries. A name refused by `propertyNames` is
 * reported once, by that error rather than by the one inside it.
 *
 * @param {string} file  The file's name, which each line begins with.
 * @param {object[]} errors  Ajv's errors, verbose, so each carries its
 *   schema and value.
 * @returns {string[]}
 */
function problemsFromErrors(file, errors) {
  const byPlace = new Map();
  for (const e of errors) {
    if (e.propertyName !== undefined) continue;
    const [place, words] = _refusal(file, e);
    if (!byPlace.has(place)) byPlace.set(place, words);
  }
  return [...byPlace.values()];
}

module.exports = {
  K,
  group,
  named,
  inRange,
  ranged,
  rangedEach,
  timer,
  listOf,
  problemsFromErrors,
};
