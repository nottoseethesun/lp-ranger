"use strict";

/**
 * @file test/clean-log-paths.test.js
 * @description `npm run clean` and `npm run clean:log` delete the log
 *   files where logging.json puts them, not where they are by default.
 *
 *   The user, 2026-10-17: `npm run clean` uses the configured value, and
 *   never deletes above the install folder. An operator's logging.json of
 *   this file's own moves both logs, so a script that still named the
 *   defaults could not pass. It is set before the script loads, because
 *   the loader reads the override directory's path at load.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clean-log-paths-"));
fs.writeFileSync(
  path.join(_USER_DIR, "logging.json"),
  JSON.stringify({
    path: "logs/moved/run.log",
    errorLogPath: "logs/moved/errors.log",
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { LOG_FILES } = require("../scripts/clean");

test("the log files are wherever the operator's logging.json puts them", () => {
  assert.deepEqual(LOG_FILES, ["logs/moved/run.log", "logs/moved/errors.log"]);
});
