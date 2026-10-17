/**
 * @file test/error-log.test.js
 * @description Tests for src/error-log.js writeErrorLog / getErrorLogPath.
 * Format invariant: every entry starts with exactly four blank lines,
 * followed by `[ISO-timestamp] context` on the fifth line, then the
 * error's stack.  The four-blank-line separator is load-bearing so the
 * file scans quickly for humans opening it after long gaps.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  writeErrorLog,
  clearErrorLog,
  resetErrorLog,
  getErrorLogPath,
} = require("../src/error-log");
const LOGGING = require("../app-config/app-defaults-for-user-configurable/logging.json");

function _tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-errlog-"));
  return path.join(dir, name);
}

test("writeErrorLog appends 4 blank lines + timestamp + stack", () => {
  const p = _tmpPath("error.log");
  const err = new Error("boom");
  const ok = writeErrorLog(err, "test context", { filePath: p });
  assert.strictEqual(ok, true);
  const contents = fs.readFileSync(p, "utf8");
  /*- The first four characters must be newlines (the four-line
   *  separator).  Nothing else in the format renders as pure \n\n\n\n. */
  assert.strictEqual(contents.slice(0, 4), "\n\n\n\n");
  /*- Context line follows immediately after the separator. */
  assert.match(
    contents,
    /^\n\n\n\n\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] test context\n/,
  );
  /*- The stack must appear after the context line. */
  assert.ok(contents.includes(err.stack));
});

test("writeErrorLog appends multiple entries with 4-line separators", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("first"), "ctx-1", { filePath: p });
  writeErrorLog(new Error("second"), "ctx-2", { filePath: p });
  const contents = fs.readFileSync(p, "utf8");
  /*- Two entries, each starting with four blank lines.  Total of
   *  eight newlines that appear in a contiguous pattern from the
   *  start of each entry.  Verify both contexts are present and in
   *  order. */
  const firstIdx = contents.indexOf("ctx-1");
  const secondIdx = contents.indexOf("ctx-2");
  assert.ok(firstIdx > 0);
  assert.ok(secondIdx > firstIdx);
  /*- The four-blank-line separator must precede the second entry too. */
  assert.ok(contents.includes("\n\n\n\n["));
  const separators = contents.split("\n\n\n\n[").length - 1;
  assert.strictEqual(separators, 2);
});

test("writeErrorLog handles non-Error input via String() coercion", () => {
  const p = _tmpPath("error.log");
  writeErrorLog("plain string error", "coerce", { filePath: p });
  const contents = fs.readFileSync(p, "utf8");
  assert.ok(contents.includes("plain string error"));
  assert.ok(contents.includes("coerce"));
});

test("writeErrorLog defaults context to '(no context)' when omitted", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("no ctx"), undefined, { filePath: p });
  const contents = fs.readFileSync(p, "utf8");
  assert.ok(contents.includes("(no context)"));
});

test("writeErrorLog returns false on write failure without throwing", () => {
  /*- Point the writer at a path whose parent cannot be created:
   *  an existing regular file used as a "directory" component.
   *  fs.mkdirSync should throw ENOTDIR internally, be swallowed,
   *  and the function returns false. */
  const parent = _tmpPath("occupied");
  fs.writeFileSync(parent, "not a dir");
  const p = path.join(parent, "child", "error.log");
  const ok = writeErrorLog(new Error("boom"), "ctx", { filePath: p });
  assert.strictEqual(ok, false);
});

test("getErrorLogPath resolves logging.json's errorLogPath to an absolute path", () => {
  const p = getErrorLogPath();
  assert.ok(path.isAbsolute(p));
  assert.strictEqual(p, path.resolve(process.cwd(), LOGGING.errorLogPath));
});

test("writeErrorLog creates parent directory if missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-errlog-mk-"));
  const p = path.join(dir, "nested", "deeper", "error.log");
  writeErrorLog(new Error("nested"), "ctx", { filePath: p });
  assert.ok(fs.existsSync(p));
});

test("clearErrorLog removes only entries matching the substring", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("a"), "[token-decimals] scope=0xa_0xb_20000 one", {
    filePath: p,
  });
  writeErrorLog(new Error("b"), "[other] unrelated entry", { filePath: p });
  writeErrorLog(new Error("c"), "[token-decimals] scope=0xa_0xb_20000 two", {
    filePath: p,
  });
  const removed = clearErrorLog("scope=0xa_0xb_20000", { filePath: p });
  assert.strictEqual(removed, true);
  const contents = fs.readFileSync(p, "utf8");
  assert.ok(!contents.includes("scope=0xa_0xb_20000"));
  assert.ok(contents.includes("[other] unrelated entry"));
});

test("clearErrorLog returns false and leaves the file when nothing matches", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("a"), "[other] entry", { filePath: p });
  const before = fs.readFileSync(p, "utf8");
  assert.strictEqual(clearErrorLog("no-such-scope", { filePath: p }), false);
  assert.strictEqual(fs.readFileSync(p, "utf8"), before);
});

test("clearErrorLog empties the file when every entry matches", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("a"), "[token-decimals] scope=X one", {
    filePath: p,
  });
  writeErrorLog(new Error("b"), "[token-decimals] scope=X two", {
    filePath: p,
  });
  assert.strictEqual(clearErrorLog("scope=X", { filePath: p }), true);
  assert.strictEqual(fs.readFileSync(p, "utf8"), "");
});

test("clearErrorLog is a safe no-op for a missing file or empty match", () => {
  const missing = _tmpPath("error.log"); // never written
  assert.strictEqual(clearErrorLog("x", { filePath: missing }), false);
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("a"), "ctx", { filePath: p });
  assert.strictEqual(clearErrorLog("", { filePath: p }), false);
  assert.strictEqual(clearErrorLog(undefined, { filePath: p }), false);
});

test("resetErrorLog deletes an existing file and returns true", () => {
  const p = _tmpPath("error.log");
  writeErrorLog(new Error("boom"), "ctx", { filePath: p });
  assert.ok(fs.existsSync(p));
  assert.strictEqual(resetErrorLog({ filePath: p }), true);
  assert.ok(!fs.existsSync(p));
});

test("resetErrorLog is a safe no-op when the file is missing", () => {
  const missing = _tmpPath("error.log"); // never written
  assert.strictEqual(resetErrorLog({ filePath: missing }), false);
});
