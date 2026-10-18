/**
 * @file test/server-pid.test.js
 * @description Tests for src/server-pid.js — write / read / remove the PID
 *   file using a temp path, so the real tmp/lp-ranger.pid is never touched.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const {
  writePidFile,
  removePidFile,
  readPid,
  getPidFilePath,
} = require("../src/server-pid");

function _tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-pid-"));
  return path.join(dir, "lp-ranger.pid");
}

test("writePidFile writes the current PID; readPid reads it back", () => {
  const p = _tmpPath();
  assert.strictEqual(writePidFile({ filePath: p }), true);
  assert.strictEqual(readPid({ filePath: p }), process.pid);
  assert.ok(fs.readFileSync(p, "utf8").includes(String(process.pid)));
});

test("removePidFile deletes the file; readPid then returns null", () => {
  const p = _tmpPath();
  writePidFile({ filePath: p });
  assert.strictEqual(removePidFile({ filePath: p }), true);
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(readPid({ filePath: p }), null);
});

test("removePidFile is a safe no-op when the file is missing", () => {
  const p = _tmpPath(); // never written
  assert.strictEqual(removePidFile({ filePath: p }), false);
});

test("readPid returns null for a missing or malformed file", () => {
  assert.strictEqual(readPid({ filePath: _tmpPath() }), null);
  const bad = _tmpPath();
  fs.writeFileSync(bad, "not-a-pid\n");
  assert.strictEqual(readPid({ filePath: bad }), null);
});

test("readPid rejects zero and negative PIDs", () => {
  const zero = _tmpPath();
  fs.writeFileSync(zero, "0\n");
  assert.strictEqual(readPid({ filePath: zero }), null);
  const neg = _tmpPath();
  fs.writeFileSync(neg, "-5\n");
  assert.strictEqual(readPid({ filePath: neg }), null);
});

/**
 * A child process writes the PID file and then ends however `how`
 * says, so the real exit path runs: Node's `exit` event, which this
 * test process cannot fire on itself.
 */
function _childWritesThen(how, p) {
  const serverPid = require.resolve("../src/server-pid");
  const script =
    `const s = require(${JSON.stringify(serverPid)});` +
    `s.writePidFile({ filePath: ${JSON.stringify(p)} });` +
    how;
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
}

for (const [name, how] of [
  ["a shutdown that calls process.exit", "process.exit(0);"],
  ["an uncaught error", "throw new Error('crash');"],
  ["the event loop running dry", ""],
]) {
  test(`the PID file goes when the server exits by ${name}`, () => {
    const p = _tmpPath();
    const r = _childWritesThen(how, p);
    assert.ok(r.stdout.includes("Wrote PID"), r.stdout + r.stderr);
    assert.ok(!fs.existsSync(p), "the exiting server left its PID file");
  });
}

test("an exiting server leaves a PID file that names another process", () => {
  // A newer server has written its own PID over this one's.
  const p = _tmpPath();
  _childWritesThen(
    `require("fs").writeFileSync(${JSON.stringify(p)}, "424242\\n");`,
    p,
  );
  assert.strictEqual(readPid({ filePath: p }), 424242);
});

test("the server records its PID and takes its signals before resolving the wallet key", () => {
  /*-
   *  Wiring, not behaviour, so it is asserted against the source: a test
   *  that started the real server would run it against the operator's
   *  files. Resolving the key can wait on a terminal prompt and then
   *  starts the managed positions one at a time, the first running while
   *  the rest wait. Until the PID file is written `npm stop` has to guess
   *  by port, and until the handlers are in place Ctrl+C and `npm stop`
   *  end the process on the spot, positions mid-start.
   */
  const src = fs
    .readFileSync(path.join(__dirname, "..", "server.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const entry = src.slice(src.indexOf("if (require.main === module)"));
  const resolve = entry.indexOf("_tryResolveKey()");
  assert.ok(resolve > 0, "the entry point resolves the wallet key");
  for (const step of [
    "writePidFile()",
    'process.on("SIGINT"',
    'process.on("SIGTERM"',
  ]) {
    const at = entry.indexOf(step);
    assert.ok(at > 0 && at < resolve, `${step} must come before the key`);
  }
});

test("getPidFilePath returns an absolute path ending in lp-ranger.pid", () => {
  const p = getPidFilePath();
  assert.ok(path.isAbsolute(p));
  assert.strictEqual(path.basename(p), "lp-ranger.pid");
});
