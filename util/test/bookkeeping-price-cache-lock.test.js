"use strict";

/**
 * @file util/test/bookkeeping-price-cache-lock.test.js
 * @description
 * Tests for the lock that lets one run of the bookkeeping report price
 * coins at a time (`util/bookkeeping/price-cache-lock.js`). A run takes it
 * and gives it back; a second run is refused, told which run holds it and
 * how to release a lock left behind. A process of its own takes the lock
 * and is stopped each way a run can be: by ending, by Ctrl+C or a kill
 * signal, which release it, and by `kill -9`, which leaves it for the
 * next run to report. Every lock file is in a folder of the test
 * process's own.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { makeTestTempFolder } = require("../../src/test-temp-folders");
const {
  PRICE_CACHE_LOCK_FILE,
  takePriceCacheLock,
} = require("../bookkeeping/price-cache-lock");

const MODULE = path.resolve(__dirname, "../bookkeeping/price-cache-lock.js");
const FOLDER = makeTestTempFolder("price-cache-lock");

/*-
 *  A run in a process of its own: it takes the lock, says so, and then
 *  either ends at once, without releasing it, or waits to be stopped.
 */
const RUN = [
  `const { takePriceCacheLock } = require(${JSON.stringify(MODULE)});`,
  "takePriceCacheLock(process.argv[1]);",
  'process.stdout.write("taken\\n");',
  'if (process.argv[2] === "wait") setInterval(() => {}, 1000);',
].join("\n");

/**
 * A lock file of the test's own, one per case.
 * @param {string} name
 * @returns {string}
 */
function lockIn(name) {
  return path.join(FOLDER, name, PRICE_CACHE_LOCK_FILE);
}

/**
 * Start a run in a process of its own.
 * @param {string} lockPath
 * @param {"end"|"wait"} mode
 * @returns {{child: import("child_process").ChildProcess,
 *   taken: Promise<void>, ended: Promise<{code: number|null,
 *   signal: string|null}>}}
 */
function runInChild(lockPath, mode) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["-e", RUN, lockPath, mode], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const taken = new Promise((resolve) => {
    child.stdout.on("data", (data) => {
      if (String(data).includes("taken")) resolve();
    });
  });
  const ended = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, taken, ended };
}

/** Whether an error refuses a run for a lock another run holds. */
const heldWith = (words) => (error) => {
  assert.equal(error.lockHeld, true);
  for (const word of words) assert.ok(error.message.includes(word), word);
  return true;
};

test("a run takes the lock, naming itself, and releasing it removes it", () => {
  const lock = lockIn("take");
  const before = process.listenerCount("SIGINT");
  const release = takePriceCacheLock(lock);
  const holder = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(holder.takenAt)), holder.takenAt);
  release();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(process.listenerCount("SIGINT"), before, "no listener left");
  release();
});

test("a second run is refused, told which run holds the lock and how to release it", () => {
  const lock = lockIn("held");
  const release = takePriceCacheLock(lock);
  try {
    const holder = JSON.parse(fs.readFileSync(lock, "utf8"));
    assert.throws(
      () => takePriceCacheLock(lock),
      heldWith([
        "Another run of the report holds the cache of prices: process " +
          `${process.pid}, since ${holder.takenAt}.`,
        "Run this one once it ends.",
        `If \`ps -p ${process.pid}\` lists no such process`,
        `delete the lock with \`rm '${lock}'\`, then run again.`,
      ]),
    );
    assert.equal(fs.existsSync(lock), true, "the holder's lock stays");
  } finally {
    release();
  }
});

test("a lock file that names no run still says how to release it", () => {
  const lock = lockIn("unnamed");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  assert.throws(
    () => takePriceCacheLock(lock),
    heldWith([
      "Another run of the report holds the cache of prices. Run this one " +
        "once it ends. If no run of the report is running",
      `\`rm '${lock}'\``,
    ]),
  );
});

test("a run that ends without releasing the lock releases it as it exits", async () => {
  const lock = lockIn("end");
  const { ended } = runInChild(lock, "end");
  const { code } = await ended;
  assert.equal(code, 0);
  assert.equal(fs.existsSync(lock), false);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`a run stopped by ${signal} releases the lock`, async () => {
    const lock = lockIn(signal);
    const { child, taken, ended } = runInChild(lock, "wait");
    await taken;
    assert.equal(fs.existsSync(lock), true);
    child.kill(signal);
    const { code } = await ended;
    assert.equal(code, 128 + os.constants.signals[signal]);
    assert.equal(fs.existsSync(lock), false);
  });
}

test("a run killed outright leaves the lock, and the next run says how to release it", async () => {
  const lock = lockIn("kill");
  const { child, taken, ended } = runInChild(lock, "wait");
  await taken;
  child.kill("SIGKILL");
  const { signal } = await ended;
  assert.equal(signal, "SIGKILL");
  assert.equal(fs.existsSync(lock), true);
  assert.throws(
    () => takePriceCacheLock(lock),
    heldWith([
      `process ${child.pid}, since`,
      `If \`ps -p ${child.pid}\` lists no such process, that run stopped ` +
        "before it could release the lock",
      `\`rm '${lock}'\``,
    ]),
  );
  fs.rmSync(lock);
  const release = takePriceCacheLock(lock);
  release();
});
