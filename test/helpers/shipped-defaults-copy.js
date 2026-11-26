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
 *
 *   The copy reads every file the folder lists, one at a time, so a file
 *   listed but gone before it is read fails the copy, and the error names
 *   it. A failed copy prints what the folders held at that moment, then
 *   throws: docs/engineering.md, "A Test File That Fails as It Loads",
 *   says how to read it.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  makeTestTempFolder,
  describeTestTempFolders,
} = require("../../src/lib/test-temp-folders");

const _SHIPPED = path.join(
  __dirname,
  "..",
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);

/**
 * What a folder holds, for the report: its entries, or why there are none.
 * @param {string} dir
 * @returns {string}
 */
function _listing(dir) {
  if (!fs.existsSync(dir)) return "GONE";
  try {
    return fs.readdirSync(dir).join(", ") || "(empty)";
  } catch (err) {
    return `unreadable (${err.code})`;
  }
}

/**
 * The report a failed copy prints: the error, what the copy's folder and
 * the shipped folder held at that moment, and every test folder in the
 * temp directory with whether its process was still running.
 * @param {string} dir   The copy's folder.
 * @param {Error} err    What the copy threw.
 * @param {string} [from]  The folder copied; the shipped folder unless a
 *   test of this report passes another.
 * @returns {string}
 */
function failedCopyReport(dir, err, from = _SHIPPED) {
  const folders = describeTestTempFolders().map(
    (f) => `    ${f.name}  pid ${f.pid} ${f.running ? "running" : "ended"}`,
  );
  return [
    `[shipped-defaults-copy] The copy of the shipped settings failed ` +
      `(pid ${process.pid}, ${new Date().toISOString()}): ${err.message}`,
    `  The copy's folder, ${dir}: ${_listing(dir)}`,
    `  The shipped folder, ${from}: ${_listing(from)}`,
    `  Test folders in ${os.tmpdir()}:`,
    ...(folders.length > 0 ? folders : ["    (none)"]),
    `  How to read this: docs/engineering.md, "A Test File That Fails as It Loads".`,
  ].join("\n");
}

/**
 * Copy the shipped settings folder into a temp folder of this process's,
 * and point the loader at the copy. A copy that fails prints its report
 * (`failedCopyReport`) and throws.
 *
 * @param {string} [shipped]  The folder copied; the shipped folder
 *   unless a test of the failure passes another.
 * @param {(text: string) => void} [print]  Where the report goes; stderr
 *   unless a test of the failure passes its own.
 * @returns {string} The copy's path.
 */
function useShippedDefaultsCopy(
  shipped = _SHIPPED,
  print = (text) => process.stderr.write(text),
) {
  const dir = makeTestTempFolder("shipped");
  try {
    for (const e of fs.readdirSync(shipped, { withFileTypes: true })) {
      const from = path.join(shipped, e.name);
      const to = path.join(dir, e.name);
      if (e.isDirectory()) fs.cpSync(from, to, { recursive: true });
      else fs.copyFileSync(from, to);
    }
  } catch (err) {
    print(`${failedCopyReport(dir, err, shipped)}\n`);
    throw err;
  }
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

module.exports = {
  useShippedDefaultsCopy,
  changeShippedCopy,
  failedCopyReport,
};
