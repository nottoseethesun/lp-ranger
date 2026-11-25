"use strict";

/**
 * @file test/check-report-kept-folders.test.js
 * @description The gate's Folders kept row (scripts/check-report.js,
 *   `_keptFoldersCheck`): green only when the tests left the install's
 *   folders as they found them; the first change named when they did not;
 *   and, when the folders could not be compared, the error that stopped
 *   it, never green.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _keptFoldersCheck } = require("../scripts/check-report");

describe("the Folders kept row", () => {
  it("is green when the tests changed nothing", () => {
    const row = _keptFoldersCheck({ keptFolders: 0 }, { changes: [] });
    assert.equal(row.ok, true);
  });

  it("names the first change when the tests made any", () => {
    const changes = ["app-data/x.json: added", "app-data/y.json: changed"];
    assert.deepEqual(_keptFoldersCheck({ keptFolders: 1 }, { changes }), {
      ok: false,
      detail: "2 change(s), first: app-data/x.json: added",
    });
  });

  it("says why when the folders were not compared, and is never green then", () => {
    const error =
      "ENOENT: no such file or directory, stat 'app-data/gone.json'";
    assert.deepEqual(
      _keptFoldersCheck({ keptFolders: 1 }, { changes: null, error }),
      { ok: false, detail: `not compared: ${error}` },
    );
  });

  it("is red when the gate wrote no report", () => {
    assert.deepEqual(_keptFoldersCheck({ keptFolders: 1 }, null), {
      ok: false,
      detail: "report missing",
    });
  });
});
