"use strict";

/**
 * @file test/file-problem.test.js
 * @description The one place a file failure LP Ranger catches is told
 *   (src/lib/file-problem.js): in the log, with the error, and through
 *   the alert the program set (the Telegram alert for other errors), in
 *   words that say what LP Ranger could not do to which file and advise
 *   checking the file's permissions and whether the disk is full, with
 *   any steps the caller adds. A missing file is no failure of a read, a
 *   copy or a delete, unless the caller says it must be there. A failure
 *   is told once while its words for that file are unchanged; another
 *   takes its place, and is told.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("util");
const { _setSinkForTests } = require("../src/lib/log");
const {
  sendFileProblemsTo,
  tellFileProblem,
  _forgetToldFileProblemsForTests,
} = require("../src/lib/file-problem");

const EACCES = { message: "EACCES: permission denied", code: "EACCES" };
const ENOENT = { message: "ENOENT: no such file", code: "ENOENT" };

let errors;
let alerts;
let restoreSink;

beforeEach(() => {
  _forgetToldFileProblemsForTests();
  errors = [];
  alerts = [];
  /*-
   *  TEST-ONLY: the log's error lines are captured through the log
   *  module's own seam, and the alert a program sets is a stand-in; both
   *  put back in `afterEach`.
   */
  restoreSink = _setSinkForTests({
    error: (...args) => errors.push(util.format(...args)),
  });
  sendFileProblemsTo((words, detail) => alerts.push({ words, detail }));
});

afterEach(() => {
  restoreSink();
  sendFileProblemsTo(null);
});

describe("a caught file failure, told", () => {
  it("says what LP Ranger could not do to which file, advises the checks, and sends it with the error", () => {
    const words = tellFileProblem({
      doing: "write to",
      file: "/x/a.json",
      err: EACCES,
    });
    assert.equal(
      words,
      "LP Ranger could not write to /x/a.json.\n\nCheck the file's permissions, and whether the disk is full.",
    );
    assert.deepEqual(alerts, [{ words, detail: "EACCES: permission denied" }]);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /\[files\] .*LP Ranger could not write to \/x\/a\.json\. Check the file's permissions, and whether the disk is full\. \(EACCES: permission denied\)/,
    );
  });

  it("names the file as the caller knows it, and adds the caller's steps", () => {
    const words = tellFileProblem({
      doing: "read",
      file: "/x/log.json",
      err: EACCES,
      what: "its rebalance log, /x/log.json",
      then: ["1. Restart."],
    });
    assert.equal(
      words,
      "LP Ranger could not read its rebalance log, /x/log.json.\n\nCheck the file's permissions, and whether the disk is full. Then:\n\n1. Restart.",
    );
  });

  it("tells nothing of a file missing for a read, a copy or a delete", () => {
    for (const doing of ["read", "copy", "delete"])
      assert.equal(
        tellFileProblem({ doing, file: `/x/${doing}`, err: ENOENT }),
        null,
        doing,
      );
    assert.deepEqual(alerts, []);
    assert.deepEqual(errors, []);
  });

  it("tells a missing file the caller says must be there, and one missing for a write", () => {
    tellFileProblem({
      doing: "read",
      file: "/x/shipped.json",
      err: ENOENT,
      missingIsNormal: false,
    });
    tellFileProblem({ doing: "write to", file: "/x/w.json", err: ENOENT });
    assert.equal(alerts.length, 2);
  });

  it("is told once while its words for that file are unchanged", () => {
    tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    const again = tellFileProblem({
      doing: "read",
      file: "/x/a.json",
      err: EACCES,
    });
    assert.equal(again, null);
    assert.equal(alerts.length, 1);
    assert.equal(errors.length, 1);
  });

  it("is told again when another failure takes its place, and for another file", () => {
    tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    tellFileProblem({ doing: "write to", file: "/x/a.json", err: EACCES });
    tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    tellFileProblem({ doing: "read", file: "/x/b.json", err: EACCES });
    assert.equal(alerts.length, 4);
  });

  it("is logged alone until a program sets where else it goes", () => {
    sendFileProblemsTo(null);
    tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    assert.deepEqual(alerts, []);
    assert.equal(errors.length, 1);
  });
});
