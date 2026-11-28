"use strict";

/**
 * @file test/build-and-start-delete-all.test.js
 * @description How `npm run build-and-start -- --delete-all-caches-and-logs`
 *   is wired (scripts/build-and-start.js). Its deletion step
 *   (scripts/delete-all-caches-and-logs.js) runs before the build, in a
 *   process of its own, since that step loads `.env` and build-and-start
 *   must not: the server it starts would take `.env`'s values for ones the
 *   shell set. It tells the step the server starts after it, which
 *   `npm run delete-all-caches-and-logs`, the same step run alone, does
 *   not. An answer other than YES stops the run with no error, any other
 *   failure stops it with the step's status, and the flag is never passed
 *   to the server.
 *
 *   The script is read, not run. Run here, a regression that let another
 *   answer through would delete this install's logs and start LP Ranger.
 *   What the step deletes, and on which answer, is tested over folders
 *   of its own in test/delete-all-caches-and-logs.test.js.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = fs.readFileSync(
  path.join(ROOT, "scripts", "build-and-start.js"),
  "utf8",
);
const STEP = fs.readFileSync(
  path.join(ROOT, "scripts", "delete-all-caches-and-logs.js"),
  "utf8",
);

describe("build-and-start --delete-all-caches-and-logs", () => {
  it("runs the deletion step before the build, in a process of its own", () => {
    const step = SCRIPT.indexOf(
      'path.join(ROOT, "scripts", "delete-all-caches-and-logs.js")',
    );
    const build = SCRIPT.indexOf('spawnSync("npm", ["run", "build"]');
    assert.ok(step > 0, "the step is run");
    assert.ok(build > step, "before the build");
    assert.match(SCRIPT, /if \(args\.includes\(DELETE_ALL_FLAG\)\) \{/);
  });

  it("stops with no error on an answer other than YES, and with the step's status on any other failure", () => {
    assert.match(
      SCRIPT,
      /if \(deletion\.status === DECLINED_EXIT\) process\.exit\(0\);/,
    );
    assert.match(
      SCRIPT,
      /if \(deletion\.status !== 0\)\s*process\.exit\(deletion\.status === null \? 1 : deletion\.status\);/,
    );
    assert.match(
      STEP,
      /process\.exitCode = _exitStatus\(outcome, serverStartsAfter\);/,
      "the step gives its status by how it ended and who runs it",
    );
  });

  it("tells its deletion step that the server starts after it", () => {
    /*-
     *  Told so, the step says the server starts after it, names
     *  `npm run delete-all-caches-and-logs` when the headless bot runs, and
     *  answers an answer other than YES with DECLINED_EXIT. Run alone,
     *  as `npm run delete-all-caches-and-logs`, it is told nothing, and
     *  starts nothing after (the user's ruling, 2026-11-28).
     */
    assert.match(
      SCRIPT,
      /\[\s*path\.join\(ROOT, "scripts", "delete-all-caches-and-logs\.js"\),\s*SERVER_STARTS_AFTER,\s*\]/,
    );
    assert.match(
      STEP,
      /readScriptArgs\(process\.argv\.slice\(2\), \[SERVER_STARTS_AFTER\]\)/,
    );
    assert.match(
      STEP,
      /const serverStartsAfter = args\.flags\.has\(SERVER_STARTS_AFTER\);/,
    );
  });

  it("is a command of its own, starting nothing after", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    assert.equal(
      pkg.scripts["delete-all-caches-and-logs"],
      "node scripts/delete-all-caches-and-logs.js",
      "no argument: the step then starts nothing after",
    );
  });

  it("keeps the flag from the server it starts", () => {
    assert.match(
      SCRIPT,
      /path\.join\(ROOT, "src", "server\.js"\),\s*\.\.\.args\.filter\(\(a\) => a !== DELETE_ALL_FLAG\)/,
    );
  });

  it("loads nothing that reads .env", () => {
    const loaded = [...SCRIPT.matchAll(/require\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(loaded.sort(), [
      "../src/server/server-cli-help",
      "./_delete-all-flag",
      "child_process",
      "path",
    ]);
  });
});
