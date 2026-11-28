"use strict";

/**
 * @file test/file-problem.test.js
 * @description The one place a file failure LP Ranger catches is told
 *   (src/lib/file-problem.js): in the log, with the error, then to the
 *   handler the program set (its stop, src/lib/stop-on-file-problem.js),
 *   in words that say what LP Ranger could not do to which file and why,
 *   from the error itself (a file error's code, or JSON that is not
 *   valid), and what to do about that cause, with any steps the caller
 *   adds. A missing file is no failure of a
 *   read, a copy or a delete, unless the caller says it must be there.
 *   Every failure is told, the same one again included: the first stops
 *   the program, and one met while it stops is still logged.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("util");
const { _setSinkForTests } = require("../src/lib/log");
const {
  handleFileProblemsWith,
  tellFileProblem,
} = require("../src/lib/file-problem");

const EACCES = { message: "EACCES: permission denied", code: "EACCES" };
const ENOENT = { message: "ENOENT: no such file", code: "ENOENT" };

let errors;
let handed;
let restoreSink;

beforeEach(() => {
  errors = [];
  handed = [];
  /*-
   *  TEST-ONLY: the log's error lines are captured through the log
   *  module's own seam, and the handler a program sets is a stand-in;
   *  both put back in `afterEach`.
   */
  restoreSink = _setSinkForTests({
    error: (...args) => errors.push(util.format(...args)),
  });
  handleFileProblemsWith((words, detail) => handed.push({ words, detail }));
});

afterEach(() => {
  restoreSink();
  handleFileProblemsWith(null);
});

describe("a caught file failure, told", () => {
  it("says what LP Ranger could not do to which file, advises the checks, and hands it on with the error", () => {
    const words = tellFileProblem({
      doing: "write to",
      file: "/x/a.json",
      err: EACCES,
    });
    assert.equal(
      words,
      "LP Ranger could not write to /x/a.json: its permissions do not allow it.\n\nCheck the permissions of the file and of its folder.",
    );
    assert.deepEqual(handed, [{ words, detail: "EACCES: permission denied" }]);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /\[files\] .*LP Ranger could not write to \/x\/a\.json: its permissions do not allow it\. Check the permissions of the file and of its folder\. \(EACCES: permission denied\)/,
    );
  });

  it("names the cause Node's error gives, and what to do about it, never another cause", () => {
    /*-
     *  No "permissions or disk full" where that is not the case (the
     *  user's ruling, 2026-11-27): each cause from the error itself.
     */
    const told = (err) =>
      tellFileProblem({ doing: "read", file: "/x/c.json", err });
    const cases = [
      [
        { code: "ENOSPC", message: "ENOSPC" },
        /: the disk is full\.\n\nFree some space on the disk\.$/,
      ],
      [
        { code: "EROFS", message: "EROFS" },
        /: the disk is read-only\.\n\nMake the disk writable\.$/,
      ],
      [
        { code: "EISDIR", message: "EISDIR" },
        /: a folder is where the file should be\./,
      ],
      [
        { code: "EMFILE", message: "EMFILE" },
        /: LP Ranger has too many files open\./,
      ],
      [{ code: "EIO", message: "EIO" }, /: the disk reported an error\./],
      [
        { code: "EWHAT", message: "EWHAT: something odd" },
        /: EWHAT: something odd\.\n\nCheck the file and the disk\.$/,
      ],
    ];
    for (const [err, words] of cases) assert.match(told(err), words, err.code);
  });

  it("says a file that is not valid JSON is not valid JSON, naming no permission or disk", () => {
    let parseError;
    try {
      JSON.parse('{ "a": ');
    } catch (err) {
      parseError = err;
    }
    for (const err of [
      parseError,
      { message: "it holds no list of rebalances", invalidContent: true },
    ]) {
      const words = tellFileProblem({ doing: "read", file: "/x/j.json", err });
      assert.match(
        words,
        /^LP Ranger could not read \/x\/j\.json: it (is not valid JSON|is not what LP Ranger writes there) \(.+\)\.\n\nCorrect the file, delete it if it is a cache \(LP Ranger rebuilds a cache\), or restore it from a backup\.$/,
      );
      assert.doesNotMatch(words, /permission|disk/i);
    }
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
      "LP Ranger could not read its rebalance log, /x/log.json: its permissions do not allow it.\n\nCheck the permissions of the file and of its folder. Then:\n\n1. Restart.",
    );
  });

  it("tells nothing of a file missing for a read, a copy or a delete", () => {
    for (const doing of ["read", "copy", "delete"])
      assert.equal(
        tellFileProblem({ doing, file: `/x/${doing}`, err: ENOENT }),
        null,
        doing,
      );
    assert.deepEqual(handed, []);
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
    assert.equal(handed.length, 2);
  });

  it("tells every failure, the same one again included, however long since the last", () => {
    /*-
     *  A failure that comes back after the file has worked again is told
     *  as the first was: nothing is remembered between them.
     */
    for (let i = 0; i < 3; i++)
      tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    assert.equal(handed.length, 3);
    assert.equal(errors.length, 3);
  });

  it("is logged alone until a program sets its handler", () => {
    handleFileProblemsWith(null);
    tellFileProblem({ doing: "read", file: "/x/a.json", err: EACCES });
    assert.deepEqual(handed, []);
    assert.equal(errors.length, 1);
  });
});
