"use strict";

/**
 * @file test/clean-log-paths.test.js
 * @description `npm run clean` and `npm run clean:log` (scripts/clean.js)
 *   deal with the log files where logging.json puts them, not where they
 *   are by default.
 *
 *   The user, 2026-10-17: `npm run clean` uses the configured value, and
 *   never deletes above the install folder. An operator's logging.json of
 *   this file's own moves both logs, so a script that still named the
 *   defaults could not pass. It is set before the script loads, because
 *   the loader reads the override directory's path at load.
 *
 *   The removals themselves run in an install folder of the test's own,
 *   so no file of the real install is touched.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const _USER_DIR = makeTestTempFolder("clean-log-settings");
fs.writeFileSync(
  path.join(_USER_DIR, "logging.json"),
  JSON.stringify({
    path: "logs/moved/run.log",
    errorLogPath: "logs/moved/errors.log",
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;

const {
  LOG_FILES,
  logFilesFrom,
  rmLogFiles,
  cleanDiagnosticLog,
} = require("../scripts/clean");

/** A stand-in install folder for one case. */
let root;
beforeEach(() => {
  root = makeTestTempFolder("clean-log-install");
});

/** Write a file in the stand-in install, its folders made. */
function put(rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

describe("the log files npm run clean removes", () => {
  it("are wherever the operator's logging.json puts them", () => {
    assert.deepEqual(LOG_FILES, [
      "logs/moved/run.log",
      "logs/moved/errors.log",
      path.join("logs/moved", "error-npm-run-check.log"),
    ]);
  });

  it("leave out a path set to nothing, which turns log-to-file off", () => {
    for (const empty of [null, "", "  "])
      assert.deepEqual(
        logFilesFrom({ path: empty, errorLogPath: "logs/error.log" }),
        ["logs/error.log", path.join("logs", "error-npm-run-check.log")],
      );
  });

  it("are each deleted, the check's error log among them", () => {
    const abs = [
      "logs/run.log",
      "logs/error.log",
      "logs/error-npm-run-check.log",
    ].map((f) => put(f, "x"));
    const files = logFilesFrom({
      path: "logs/run.log",
      errorLogPath: "logs/error.log",
    });
    const { outside } = rmLogFiles(files, root);
    assert.deepEqual(outside, []);
    for (const p of abs) assert.equal(fs.existsSync(p), false, `${p} is left`);
  });

  it("are left alone outside the install folder", () => {
    const { removed, outside } = rmLogFiles(["../elsewhere.log"], root);
    assert.deepEqual(removed, []);
    assert.deepEqual(outside, ["../elsewhere.log"]);
  });
});

describe("npm run clean:log", () => {
  it("empties the log in place, so a server writing it goes on writing it", () => {
    const p = put("logs/run.log", "an earlier run's lines\n");
    const inode = fs.statSync(p).ino;
    // The server's own handle: opened to append, as src/log-file.js does.
    const fd = fs.openSync(p, "a");
    try {
      cleanDiagnosticLog({ logPath: "logs/run.log", root });
      fs.writeSync(fd, "a line after the clear\n");
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.statSync(p).ino, inode, "the same file, not a new one");
    assert.equal(fs.readFileSync(p, "utf8"), "a line after the clear\n");
  });

  it("says so, and stops, when logging.json sets no path", () => {
    assert.doesNotThrow(() => cleanDiagnosticLog({ logPath: null, root }));
  });

  it("leaves a log outside the install folder alone", () => {
    const outside = path.join(
      makeTestTempFolder("clean-log-elsewhere"),
      "x.log",
    );
    fs.writeFileSync(outside, "keep\n");
    cleanDiagnosticLog({ logPath: outside, root });
    assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
  });
});
