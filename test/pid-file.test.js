/**
 * @file test/pid-file.test.js
 * @description Tests for src/lib/pid-file.js — write / read / remove a PID
 *   file using a temp path, so the real tmp/lp-ranger.pid and
 *   tmp/lp-ranger-bot.pid are never touched.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  writePidFile,
  removePidFile,
  readPid,
  getPidFilePath,
  BOT_PID_FILE,
} = require("../src/lib/pid-file");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

function _tmpPath() {
  return path.join(makeTestTempFolder("pid"), "lp-ranger.pid");
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
  const pidFile = require.resolve("../src/lib/pid-file");
  const script =
    `const s = require(${JSON.stringify(pidFile)});` +
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
    .readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8")
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

test("the headless bot's PID file is its own, beside the server's", () => {
  const bot = getPidFilePath({ filePath: BOT_PID_FILE });
  assert.ok(path.isAbsolute(bot));
  assert.strictEqual(path.basename(bot), "lp-ranger-bot.pid");
  assert.strictEqual(path.dirname(bot), path.dirname(getPidFilePath()));
});

test("the headless bot records its PID and takes SIGUSR2 before asking for its key", () => {
  /*-
   *  Wiring, asserted against the source as the server's is above: a
   *  test that started the real bot would run it against the operator's
   *  files. The key can wait on a terminal prompt, and then the start-up
   *  starts the managed positions one at a time. Until the PID file is
   *  written, `--delete-all-caches-and-logs` cannot find the bot; and
   *  until SIGUSR2 has a handler, the signal it sends ends the process on
   *  the spot, as a signal with none does, so the handler comes first.
   */
  const src = fs
    .readFileSync(path.join(__dirname, "..", "src", "bot.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const main = src.slice(
    src.indexOf("async function main()"),
    src.indexOf("function _installGentleStop()"),
  );
  const installer = src.slice(src.indexOf("function _installGentleStop()"));
  assert.match(installer, /process\.on\("SIGUSR2"/);
  const key = main.indexOf("resolvePrivateKey(");
  const stop = main.indexOf("_installGentleStop()");
  const pid = main.indexOf("writePidFile(");
  assert.ok(key > 0, "main asks for the key");
  assert.ok(stop > 0 && pid > stop, "the handler, then the PID file");
  assert.ok(pid < key, "both before the key");
});

test("the log line names each program's recommended stop first", () => {
  /*-
   *  The server's is `npm run gentle-stop`, which lets a rebalance finish;
   *  `npm stop` is the force-stop. The headless bot serves no http, so its
   *  gentle stop is SIGUSR2 to its own PID; Ctrl+C is its force-stop. The
   *  log is a stand-in, put back after.
   */
  const { _setSinkForTests } = require("../src/lib/log");
  const lines = [];
  const restoreLog = _setSinkForTests({
    log: (...a) => lines.push(require("util").format(...a)),
    warn: () => {},
    error: () => {},
  });
  try {
    writePidFile({ filePath: _tmpPath() });
  } finally {
    restoreLog();
  }
  assert.ok(
    lines.some((l) =>
      l.includes("stop with `npm run gentle-stop`, or `npm stop` to force it"),
    ),
    lines.join("\n"),
  );
  const bot = fs.readFileSync(
    path.join(__dirname, "..", "src", "bot.js"),
    "utf8",
  );
  assert.match(
    bot,
    /howToStop: `\\`kill -USR2 \$\{process\.pid\}\\`, or Ctrl\+C to force it`,/,
  );
});
