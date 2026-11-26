"use strict";

/**
 * @file test/shipped-defaults-copy.test.js
 * @description The report a failed copy of the shipped settings prints
 *   (`failedCopyReport`, test/helpers/shipped-defaults-copy.js): the
 *   error, what the copy's folder and the folder copied held, and every
 *   test folder with whether its process still runs. It is what
 *   docs/engineering.md, "A Test File That Fails as It Loads", says to
 *   read, and it runs only when a copy fails, so it is tested here rather
 *   than left to its first failure.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  failedCopyReport,
  useShippedDefaultsCopy,
} = require("./helpers/shipped-defaults-copy");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

describe("the report of a failed copy of the shipped settings", () => {
  it("names the error, what each folder held, and the test folders", () => {
    const from = makeTestTempFolder("copied");
    fs.writeFileSync(path.join(from, "a.json"), "{}");
    const dir = makeTestTempFolder("copy");
    const err = new Error(
      "ENOENT: no such file or directory, copyfile 'x.json' -> 'y.json'",
    );
    const report = failedCopyReport(dir, err, from);
    assert.ok(report.includes("The copy of the shipped settings failed"));
    assert.ok(report.includes("copyfile 'x.json' -> 'y.json'"), report);
    assert.ok(report.includes(`The copy's folder, ${dir}: (empty)`), report);
    assert.ok(report.includes(`The shipped folder, ${from}: a.json`), report);
    assert.ok(
      report.includes(`${path.basename(dir)}  pid ${process.pid} running`),
      report,
    );
  });

  it("says when the copy's folder is gone", () => {
    const dir = makeTestTempFolder("copy");
    fs.rmdirSync(dir);
    const report = failedCopyReport(dir, new Error("x"));
    assert.ok(report.includes(`The copy's folder, ${dir}: GONE`), report);
  });

  it("is printed by a copy that fails, which then throws", () => {
    const shipped = path.join(makeTestTempFolder("copied"), "missing");
    const printed = [];
    const before = process.env.LP_RANGER_DEFAULTS_DIR;
    assert.throws(
      () => useShippedDefaultsCopy(shipped, (text) => printed.push(text)),
      /ENOENT/,
    );
    assert.equal(printed.length, 1);
    assert.ok(printed[0].includes("The copy of the shipped settings failed"));
    assert.ok(printed[0].includes(`The shipped folder, ${shipped}: GONE`));
    assert.equal(process.env.LP_RANGER_DEFAULTS_DIR, before, "loader left");
  });
});
