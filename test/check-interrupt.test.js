"use strict";

/**
 * @file test/check-interrupt.test.js
 * @description A Ctrl+C during `npm run check` stops it after the test
 *   run it interrupted, rather than starting the next with the
 *   operator's files still moved out.
 *
 *   scripts/check.js keeps itself alive through an interrupt with a
 *   signal listener, so it can put the operator's files back. A listener
 *   runs only when the event loop is free, so the script awaits each
 *   test run (`runAsync`, scripts/_run-async.js) rather than blocking in
 *   `spawnSync`. Two checks: a script built that way notices a Ctrl+C
 *   sent while it waits and skips its next step, and check.js is built
 *   that way. The script itself runs the whole suite when loaded, so its
 *   shape is read rather than run.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const RUN_ASYNC = path.join(__dirname, "..", "scripts", "_run-async.js");

/*-
 *  Two steps, as check.js has: the first waits on a command that runs
 *  until it is stopped, the second must not start once an interrupt has
 *  been noticed.
 */
const PARENT = `
const { runAsync } = require(${JSON.stringify(RUN_ASYNC)});
let interrupted = null;
process.on("SIGINT", (signal) => { interrupted = signal; });
(async () => {
  const first = runAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  process.stdout.write("WAITING\\n");
  await first;
  if (interrupted !== null) {
    process.stdout.write("STOPPED " + interrupted + "\\n");
    return;
  }
  await runAsync(process.execPath, ["-e", ""]);
  process.stdout.write("SECOND STEP RAN\\n");
})();
`;

/**
 * Run the two-step script in a process group of its own, as a terminal
 * runs a job, and press Ctrl+C on the group once it is waiting.
 * @returns {Promise<string>} What it wrote.
 */
function interruptWhileWaiting() {
  const file = path.join(makeTestTempFolder("check-interrupt"), "parent.js");
  fs.writeFileSync(file, PARENT);
  return new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, [file], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const giveUp = setTimeout(() => {
      process.kill(-parent.pid, "SIGKILL");
      reject(new Error(`no end after the interrupt: ${out}`));
    }, 20_000);
    parent.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
      if (d.includes("WAITING")) process.kill(-parent.pid, "SIGINT");
    });
    parent.stderr.setEncoding("utf8").on("data", (d) => (out += d));
    parent.on("close", () => {
      clearTimeout(giveUp);
      resolve(out);
    });
  });
}

describe("an interrupt during npm run check", () => {
  it("is noticed while a test run is awaited, and the next step does not start", async () => {
    const out = await interruptWhileWaiting();
    assert.match(out, /STOPPED SIGINT/);
    assert.doesNotMatch(out, /SECOND STEP RAN/);
  });

  it("stops check.js between its two test runs", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "check.js"),
      "utf8",
    );
    const first = src.indexOf("const configRun = await runAsync(");
    const second = src.indexOf("const testsRun = await runAsync(");
    assert.ok(first > -1, "the config-value tests are awaited");
    assert.ok(second > first, "and then the rest of the suite");
    const between = src.slice(first, second);
    assert.match(
      between,
      /if \(interrupted !== null\) throw/,
      "an interrupt stops the run before the second",
    );
  });
});
