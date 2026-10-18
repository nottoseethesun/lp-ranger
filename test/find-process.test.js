/**
 * @file test/find-process.test.js
 * @description `npm stop` signals the PID in `tmp/lp-ranger.pid` only
 *   while that PID is still this install's LP Ranger server. The file
 *   outlives a server killed outright, and the system may have given its
 *   number to another process since — another project's `node server.js`
 *   among them; `serverProcessState` is what tells them apart, from the
 *   command line and the working directory together.
 *
 *   Drives real processes through the real `ps`: this test process, which
 *   is not the server, and children running a script named `server.js`
 *   from this install's root and from somewhere else.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  serverProcessState,
  psCmd,
  processCwd,
  sortServerPids,
} = require("../scripts/_find-process");

/** Run a `server.js` from a scratch directory, with `cwd` as its working directory. */
async function withServerScript(cwd, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-stop-"));
  const script = path.join(dir, "server.js");
  fs.writeFileSync(script, "setTimeout(() => {}, 30000);\n");
  const child = spawn(process.execPath, [script], {
    stdio: "ignore",
    cwd: cwd === null ? dir : cwd,
  });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    await fn(child.pid);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a process that is not the server is not taken for it", () => {
  assert.ok(psCmd(process.pid).length > 0, "ps must report this process");
  assert.strictEqual(serverProcessState(process.pid), "no");
});

test("a server.js running from this install's root is the server", async () => {
  await withServerScript(process.cwd(), async (pid) => {
    assert.strictEqual(processCwd(pid), fs.realpathSync(process.cwd()));
    assert.strictEqual(serverProcessState(pid), "yes");
  });
});

test("a server.js running from another directory is not this install's server", async () => {
  await withServerScript(null, async (pid) => {
    assert.strictEqual(serverProcessState(pid), "no");
  });
});

test("only this install's server is sorted as ours, when stopping by port", async () => {
  /*-
   *  `npm stop` falls back to the port when the PID file is missing or
   *  stale. Whatever listens there is sorted the way the PID file is
   *  judged: another project's server, or any other program, is in
   *  neither list and is not signalled.
   */
  await withServerScript(process.cwd(), async (ourPid) => {
    await withServerScript(null, async (otherPid) => {
      const dead = 2 ** 22 + 1;
      const { ours, unknown } = sortServerPids([
        ourPid,
        otherPid,
        process.pid,
        dead,
      ]);
      assert.deepStrictEqual(ours, [ourPid]);
      assert.deepStrictEqual(unknown, [dead]);
    });
  });
});

test("a PID with no process behind it cannot be vouched for", () => {
  /*-
   *  Above the largest PID Linux (2^22) or macOS can issue, so nothing
   *  can hold it. `npm stop` asks whether the process is alive before it
   *  asks this, so it treats such a file as stale.
   */
  assert.strictEqual(serverProcessState(2 ** 22 + 1), "unknown");
});
