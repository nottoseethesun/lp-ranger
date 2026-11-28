"use strict";

/**
 * @file test/file-problem-sites.test.js
 * @description Places that catch a file failure tell it the one way
 *   (src/lib/file-problem.js), in the log and through the alert the
 *   program set, and go on doing what they did: a cache read that fails
 *   starts empty, a cache write that fails is not thrown, the settings
 *   save goes on, the PID file's failure does not stop a start, the error
 *   log's write never throws, and the api keys' save still fails to its
 *   caller. A cache not written yet is no failure. Each case works over a
 *   folder or a stand-in file system of its own.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");
const {
  sendFileProblemsTo,
  _forgetToldFileProblemsForTests,
} = require("../src/lib/file-problem");
const { createCacheStore } = require("../src/lib/cache-store");
const { saveConfig } = require("../src/lib/bot-config-v2");
const { writePidFile } = require("../src/server/server-pid");
const { writeErrorLog } = require("../src/lib/error-log");
const { apiKeysPath, saveEncryptedKey } = require("../src/lib/api-key-store");

let alerts;
let restoreSink;

beforeEach(() => {
  _forgetToldFileProblemsForTests();
  alerts = [];
  /*-
   *  TEST-ONLY: the log's lines are kept off the test's output through
   *  the log module's own seam, and the alert a program sets is a
   *  stand-in; both put back in `afterEach`.
   */
  restoreSink = _setSinkForTests({
    log: () => {},
    warn: () => {},
    error: () => {},
  });
  sendFileProblemsTo((words) => alerts.push(words));
});

afterEach(() => {
  restoreSink();
  sendFileProblemsTo(null);
});

/** An fs stand-in whose `name` call fails with `code`. */
function failing(name, code) {
  return {
    ...fs,
    [name]: () => {
      throw Object.assign(new Error(`${code}: refused`), { code });
    },
  };
}

describe("a cache's failed read or write", () => {
  it("starts the cache empty and tells a read that fails", async () => {
    const store = createCacheStore({
      filePath: "/x/event-cache.json",
      defaultTtlMs: 60_000,
      fsModule: failing("readFileSync", "EACCES"),
    });
    assert.equal(await store.get("k"), null);
    assert.equal(alerts.length, 1);
    assert.match(
      alerts[0],
      /^LP Ranger could not read \/x\/event-cache\.json\./,
    );
  });

  it("tells nothing of a cache not written yet", async () => {
    const store = createCacheStore({
      filePath: "/x/event-cache.json",
      defaultTtlMs: 60_000,
      fsModule: failing("readFileSync", "ENOENT"),
    });
    await store.get("k");
    assert.deepEqual(alerts, []);
  });

  it("tells a write that fails, never throwing it", async () => {
    const store = createCacheStore({
      filePath: "/x/event-cache.json",
      defaultTtlMs: 60_000,
      fsModule: {
        ...failing("writeFileSync", "ENOSPC"),
        readFileSync: () => "{}",
        mkdirSync: () => {},
      },
    });
    await store.set("k", 1);
    assert.equal(alerts.length, 1);
    assert.match(
      alerts[0],
      /^LP Ranger could not write to \/x\/event-cache\.json\./,
    );
  });
});

describe("the settings save", () => {
  it("tells a failed write of bot-config.json, and goes on", () => {
    const dir = makeTestTempFolder("file-problem-config");
    // A folder where the save's copy goes: the write fails.
    fs.mkdirSync(path.join(dir, "bot-config.json.tmp"));
    assert.doesNotThrow(() =>
      saveConfig({ global: {}, positions: { k: { status: "running" } } }, dir),
    );
    assert.ok(
      alerts.some((w) =>
        w.startsWith(
          `LP Ranger could not write to ${path.join(dir, "bot-config.json")}.`,
        ),
      ),
      alerts.join("\n"),
    );
  });
});

describe("the server's PID file", () => {
  it("tells a write that fails, and lets the start go on", () => {
    const file = path.join(makeTestTempFolder("file-problem-pid"), "a-file");
    fs.writeFileSync(file, "");
    // Its folder is a file: the write fails.
    assert.equal(writePidFile({ filePath: path.join(file, "x.pid") }), false);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /^LP Ranger could not write to .*x\.pid\./);
  });
});

describe("the error log", () => {
  it("tells a write that fails, never throwing", () => {
    const file = path.join(makeTestTempFolder("file-problem-errlog"), "e.log");
    fs.mkdirSync(file);
    assert.equal(
      writeErrorLog(new Error("boom"), "ctx", { filePath: file }),
      false,
    );
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /^LP Ranger could not write to .*e\.log\./);
  });
});

describe("the api keys' save", () => {
  it("tells a write that fails, and still fails to its caller", async () => {
    const file = apiKeysPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A folder where the save's copy goes: the write fails.
    fs.mkdirSync(`${file}.tmp`);
    try {
      await assert.rejects(saveEncryptedKey("moralis", "key", "pw"));
      assert.ok(
        alerts.some((w) =>
          w.startsWith(`LP Ranger could not write to ${file}.`),
        ),
        alerts.join("\n"),
      );
    } finally {
      fs.rmSync(`${file}.tmp`, { recursive: true, force: true });
    }
  });
});
