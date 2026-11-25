"use strict";

/**
 * @file test/env-file.test.js
 * @description Which `.env` file the app reads (`envFilePath`,
 *   `loadEnvFile`, src/lib/env-settings.js): the install's, in the working
 *   directory, and none under `node --test`, so no test runs on the
 *   operator's choices. The settings check reads the same one
 *   (src/lib/settings-check.js).
 *
 *   Each case runs in a child process from a folder of its own holding a
 *   `.env`, with the test runner's marker or, standing in for an install,
 *   without it, and with an empty folder for the operator's copies of the
 *   settings files. Nothing near the operator's own install is read.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const lib = (name) =>
  JSON.stringify(path.join(__dirname, "..", "src", "lib", name));

/**
 * What `script` writes after "OUT=", run in a child process from a folder
 * of its own whose `.env` sets `PORT=5599` and `NOT_A_SETTING=1`, with the
 * test runner's marker unless `asInstall`. PORT is left out of the child's
 * environment, so only the `.env` can set it.
 * @param {string} script
 * @param {{asInstall?: boolean}} [opts]
 * @returns {{out: *, cwd: string}}  What it wrote, parsed as JSON, and
 *   its folder.
 */
function inChild(script, { asInstall = false } = {}) {
  const cwd = fs.realpathSync(makeTestTempFolder("env-file"));
  fs.writeFileSync(path.join(cwd, ".env"), "PORT=5599\nNOT_A_SETTING=1\n");
  const env = {
    ...process.env,
    LP_RANGER_USER_CONFIG_DIR: makeTestTempFolder("env-file-overrides"),
  };
  delete env.PORT;
  if (asInstall) delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ["-e", script], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  // The answer follows the child's log lines, which share its stdout.
  return { out: JSON.parse(res.stdout.match(/\nOUT=(.*)$/)[1]), cwd };
}

const LOAD = `
  const e = require(${lib("env-settings")});
  e.loadEnvFile();
  process.stdout.write("\\nOUT=" + JSON.stringify({
    file: e.envFilePath(),
    port: process.env.PORT ?? null,
  }));
`;

const CHECK = `
  const s = require(${lib("settings-check")});
  const named = s.settingsProblems().filter((p) => p.includes("NOT_A_SETTING"));
  process.stdout.write("\\nOUT=" + JSON.stringify(named));
`;

describe("the .env file the app reads", () => {
  it("is the install's, in the working directory, which loadEnvFile loads", () => {
    const { out, cwd } = inChild(LOAD, { asInstall: true });
    assert.deepEqual(out, { file: path.join(cwd, ".env"), port: "5599" });
  });

  it("is none under node --test, so loadEnvFile loads nothing", () => {
    assert.deepEqual(inChild(LOAD).out, { file: null, port: null });
  });

  it("is the one the settings check reads", () => {
    assert.equal(
      inChild(CHECK, { asInstall: true }).out.length,
      1,
      "the install's .env is checked",
    );
    assert.deepEqual(inChild(CHECK).out, [], "none under node --test");
  });
});
