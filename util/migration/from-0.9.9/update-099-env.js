"use strict";

/**
 * @file util/migration/from-0.9.9/update-099-env.js
 * @description
 * A migration step: bring `.env`, as release 0.9.9 read it, up to how
 * this release reads it.
 *
 * This release checks `.env` at startup against the list of variables
 * it reads, and reads each one by a strict rule, so two kinds of line
 * 0.9.9 took would stop the server:
 *
 *   - a variable this release no longer reads: `SLIPPAGE_PCT`, since
 *     slippage is two settings of each position now, and
 *     `AGGREGATOR_API_KEY`, since no aggregator takes a key. The line
 *     becomes a comment, so its value stays in the file to be seen;
 *   - `DRY_RUN` or `VERBOSE` written other than `true` or `false`. Each
 *     is written as 0.9.9 read it: 0.9.9 ran dry for 1, true or yes, in
 *     any letter case, and logged verbosely only for 1. So an install
 *     that ran dry still runs dry, and one that sent transactions still
 *     sends them.
 *
 * The file is read and rewritten by util/migration/env-file.js, which
 * keeps each changed line as a comment, makes no copy of the file, since
 * it holds the private key, and quotes no value in the report.
 */

const { valueOf, retiredVariable, rewriteEnv } = require("../env-file");

/** The variables 0.9.9 read and this release does not, and why. */
const _RETIRED = Object.freeze({
  SLIPPAGE_PCT: "slippage is two settings of each position now",
  AGGREGATOR_API_KEY: "no aggregator takes a key now",
});

/** How 0.9.9 read each on/off variable: on for these, off otherwise. */
const _ON_IN_099 = Object.freeze({
  DRY_RUN: (t) => ["1", "true", "yes"].includes(t.toLowerCase()),
  VERBOSE: (t) => t === "1",
});

/**
 * One line's replacement, and the report's line for it, or null when the
 * line stands. `s` is what the line sets.
 */
function _change(line, s, v) {
  const { prefix, name, rest } = s;
  if (Object.hasOwn(_RETIRED, name))
    return retiredVariable(line, name, _RETIRED[name], v);
  const readAs = _ON_IN_099[name];
  const value = valueOf(rest);
  if (readAs === undefined || value === "") return null;
  if (value === "true" || value === "false") return null;
  const now = readAs(value) ? "true" : "false";
  return {
    lines: [
      `# util/migration wrote this as 0.9.9 read it; it was: ${line}`,
      `${prefix}${name}=${now}`,
    ],
    said: `${v("wrote", "would write")} ${name} as ${now}, as 0.9.9 read it`,
  };
}

/**
 * Bring the install's `.env` up to how this release reads it.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @returns {string[]}  One line for each change, or none.
 */
function update099Env({ root, dryRun }) {
  return rewriteEnv({ root, dryRun }, _change);
}

module.exports = { update099Env };
