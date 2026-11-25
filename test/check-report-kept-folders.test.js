"use strict";

/**
 * @file test/check-report-kept-folders.test.js
 * @description The gate's Folders kept stage. The row (scripts/check-report.js,
 *   `_keptFoldersCheck`) is green only for folders compared and unchanged:
 *   it names the first change when there were any, and, when the folders
 *   could not be compared, the error that stopped it, never green. The
 *   stage's outcome (scripts/_kept-folders.js) fails it likewise. And in
 *   scripts/check.js, which runs the whole gate as it loads and so is read
 *   here as text: the folders start as not compared, and a stage's status
 *   is kept only once its report is written.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _keptFoldersCheck } = require("../scripts/check-report");
const { keptFoldersOutcome } = require("../scripts/_kept-folders");

const ERROR = "ENOENT: no such file or directory, stat 'app-data/gone.json'";

describe("the Folders kept row", () => {
  it("is green only when the folders were compared and nothing changed", () => {
    const row = _keptFoldersCheck({ changes: [], error: null });
    assert.equal(row.ok, true);
  });

  it("names the first change when the tests made any", () => {
    const changes = ["app-data/x.json: added", "app-data/y.json: changed"];
    assert.deepEqual(_keptFoldersCheck({ changes, error: null }), {
      ok: false,
      detail: "2 change(s), first: app-data/x.json: added",
    });
  });

  it("says why when the folders were not compared, and is never green then", () => {
    assert.deepEqual(_keptFoldersCheck({ changes: null, error: ERROR }), {
      ok: false,
      detail: `not compared: ${ERROR}`,
    });
  });

  it("says so when a report names no reason", () => {
    assert.deepEqual(_keptFoldersCheck({ changes: null }), {
      ok: false,
      detail: "not compared: no reason recorded",
    });
  });

  it("is red when the gate wrote no report", () => {
    assert.deepEqual(_keptFoldersCheck(null), {
      ok: false,
      detail: "report missing",
    });
  });
});

describe("the Folders kept stage's outcome", () => {
  it("passes only for folders compared and unchanged", () => {
    assert.deepEqual(keptFoldersOutcome([], null), {
      exit: 0,
      report: { changes: [], error: null },
    });
  });

  it("fails, with the changes, when the tests made any", () => {
    assert.equal(keptFoldersOutcome(["app-data/x.json: added"], null).exit, 1);
  });

  it("fails, naming the error, when the folders were not compared", () => {
    assert.deepEqual(keptFoldersOutcome(null, ERROR), {
      exit: 1,
      report: { changes: null, error: ERROR },
    });
  });
});

describe("the gate's test stage (scripts/check.js)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "check.js"),
    "utf8",
  );

  it("starts with the folders not compared", () => {
    assert.match(src, /let folderChanges = null;/);
  });

  it("keeps each stage's status only once its report is written", () => {
    for (const [tap, status] of [
      ['"config-values.tap"', "configValuesExit = configRun.status;"],
      ['"tests.tap"', "testsExit = testsRun.status;"],
    ]) {
      const write = src.indexOf(tap);
      const kept = src.indexOf(status);
      assert.ok(write > 0 && kept > write, `${status} after ${tap}`);
    }
  });

  it("records the stage's outcome through the helper the tests load", () => {
    assert.match(src, /keptFoldersOutcome\(folderChanges, folderError\)/);
  });
});
