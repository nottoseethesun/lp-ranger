"use strict";

/**
 * @file test/plain-script-refusals.test.js
 * @description A test file that would write the operator's files when run
 *   as a plain script (`node test/x.test.js`) refuses before it loads the
 *   app: only the test runner gives each process files and a rebalance
 *   log of its own. Each is run so here, without the runner's marker and
 *   from a folder of its own, and must exit 1 saying why, having loaded
 *   no module under src/ but src/lib/test-temp-folders.js, which writes
 *   nothing as it loads. A preload lists, as the child exits, what it
 *   loaded.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src") + path.sep;
const ALLOWED = path.join(ROOT, "src", "lib", "test-temp-folders.js");

/**
 * Write a preload that prints, as its process exits, every module under
 * src/ the process loaded.
 * @returns {string}  The preload's path.
 */
function loadedModulesPreload() {
  const file = path.join(
    makeTestTempFolder("plain-script-preload"),
    "loaded.js",
  );
  fs.writeFileSync(
    file,
    `"use strict";\n` +
      `const src = ${JSON.stringify(SRC)};\n` +
      `process.on("exit", () => {\n` +
      `  const loaded = Object.keys(require.cache).filter((f) => f.startsWith(src));\n` +
      `  process.stderr.write("\\nLOADED=" + JSON.stringify(loaded) + "\\n");\n` +
      `});\n`,
  );
  return file;
}

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
      const res = spawnSync(
        process.execPath,
        ["--require", loadedModulesPreload(), path.join(ROOT, file)],
        {
          cwd: makeTestTempFolder("plain-script"),
          env: plainScriptEnv(),
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, why);
      const listed = res.stderr.match(/\nLOADED=(.*)\n/);
      assert.ok(listed !== null, res.stderr);
      const loaded = JSON.parse(listed[1]).filter((f) => f !== ALLOWED);
      assert.deepEqual(loaded, [], "modules of the app it loaded first");
    });
});
