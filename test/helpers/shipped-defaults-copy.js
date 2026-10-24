/**
 * @file test/helpers/shipped-defaults-copy.js
 * @description A copy of the shipped settings folder
 *   (`app-config/app-defaults-for-user-configurable/`) for one test
 *   process, which src/lib/load-merged-defaults.js reads in place of the
 *   tracked folder (`LP_RANGER_DEFAULTS_DIR`).
 *
 *   A test that has to replace or remove a shipped file, to show how its
 *   reader copes, changes the copy. The tracked file stays as it ships,
 *   so no other test process reads what the test wrote, and a run
 *   stopped part way leaves nothing for the next `npm start` to trip on.
 *   The copy is a test temp folder, removed when the process exits.
 *
 *   The loader reads the variable when it loads, so a test calls this
 *   before it requires anything under src/lib/ that reads a settings file.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");

const _SHIPPED = path.join(
  __dirname,
  "..",
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);

/**
 * Copy the shipped settings folder into a temp folder of this process's,
 * and point the loader at the copy.
 *
 * @returns {string} The copy's path.
 */
function useShippedDefaultsCopy() {
  const dir = makeTestTempFolder("shipped");
  fs.cpSync(_SHIPPED, dir, { recursive: true });
  process.env.LP_RANGER_DEFAULTS_DIR = dir;
  return dir;
}

/** `changes` laid over `base`, nested groups merged, everything else replaced. */
function _over(base, changes) {
  const out = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    const group =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] !== null &&
      typeof base[key] === "object";
    out[key] = group ? _over(base[key], value) : value;
  }
  return out;
}

/**
 * Change some values in one file of the copy, keeping the rest as shipped.
 *
 * @param {string} dir      The copy, from `useShippedDefaultsCopy`.
 * @param {string} file     The file's name, e.g. `bot-config-defaults.json`.
 * @param {object} changes  The values to change, nested as in the file.
 * @returns {object} The file as the copy now holds it.
 */
function changeShippedCopy(dir, file, changes) {
  const where = path.join(dir, file);
  const changed = _over(JSON.parse(fs.readFileSync(where, "utf8")), changes);
  fs.writeFileSync(where, JSON.stringify(changed, null, 2));
  return changed;
}

module.exports = { useShippedDefaultsCopy, changeShippedCopy };
