"use strict";

/**
 * @file test/plain-script-refusals.test.js
 * @description A test file that would write the operator's files when run
 *   as a plain script (`node test/x.test.js`) refuses before it loads the
 *   app: only the test runner gives each process files and a rebalance
 *   log of its own. Each is run so here, without the runner's marker and
 *   from a folder of its own, and must exit 1 saying why.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const ROOT = path.join(__dirname, "..");

// Each file that refuses, and the words its refusal must carry.
const REFUSING = [
  ["test/_bot-loop-helpers.js", /would write the operator's rebalance log/],
  ["test/server.test.js", /would write the operator's settings/],
  ["test/server-spa-fallback.test.js", /would write the operator's settings/],
];

/**
 * This process's environment without the test runner's marker, as a
 * plain script run from a shell sees it.
 * @returns {object}
 */
function plainScriptEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

describe("a test file run as a plain script", () => {
  for (const [file, why] of REFUSING)
    it(`${file} refuses before it loads the app`, () => {
      const res = spawnSync(process.execPath, [path.join(ROOT, file)], {
        cwd: makeTestTempFolder("plain-script"),
        env: plainScriptEnv(),
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, why);
    });
});
