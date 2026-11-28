"use strict";

/**
 * @file test/rebalance-log.test.js
 * @description The rebalance log's reads and writes
 *   (src/bot/rebalance-log.js), which every reader and writer of the log
 *   in the bot and the server goes through. There being no log yet is no
 *   error: it reads as empty, and the first rebalance creates it. Any
 *   other failed read or write is told to the operator as every file
 *   failure is (src/lib/file-problem.js): logged, sent through the alert
 *   the program set, and kept for the status answers, in words that say
 *   whether reading or writing failed, advise checking the file's
 *   permissions and whether the disk is full, then restarting LP Ranger,
 *   reloading the position and, should that not help, deleting every
 *   cache and log. A failure is told once while its words are unchanged.
 *   A write never throws, so the rebalance's record-keeping goes on, and
 *   a log that could not be read is never written over. Every status
 *   answer carries the last failure to the dashboard. Each case points
 *   the log at a file of its own.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");
const { sendFileProblemsTo } = require("../src/lib/file-problem");
const { useRebalanceLog } = require("./helpers/rebalance-log");
const {
  readLog,
  appendLog,
  rebalanceLogProblem,
  _forgetRebalanceLogProblemForTests,
} = require("../src/bot/rebalance-log");
const config = require("../src/lib/config");
const { createApiStatusHandler } = require("./_bot-route-adapters");
const { managedKeys } = require("../src/lib/bot-config-v2");
const { primaryRouteLabel } = require("../src/bot/rebalancer-swap");
const { moralisEnabledIn } = require("../src/lib/moralis-key");

const DIR = makeTestTempFolder("rebalance-log");

let _cases = 0;
let _restoreLog = null;
let _restoreSink = null;
let _errors = [];
let _alerts = [];

/**
 * A log of this case's own, in a folder of its own, holding `text`, or
 * none when `text` is undefined.
 * @param {string} [text]
 * @returns {string}  The log's path.
 */
function caseLog(text) {
  _cases += 1;
  const dir = path.join(DIR, `case-${_cases}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, "rebalance_log.json");
  if (text !== undefined) fs.writeFileSync(file, text);
  _restoreLog = useRebalanceLog(file);
  return file;
}

/** The steps every failure advises, after its first line. */
function assertAdvice(message) {
  assert.match(
    message,
    /Check the file's permissions, and whether the disk is full\./,
  );
  assert.match(
    message,
    /1\. Restart LP Ranger: its server \(or headless bot\) and the web browser\./,
  );
  assert.match(
    message,
    /2\. In the dashboard, open Settings → Reload Current Position\./,
  );
  assert.match(
    message,
    /3\. If the app still does not work on restart, you will need to remove the old log: run npm run build-and-start -- --delete-all-caches-and-logs, which removes it with all of LP Ranger's other caches and logs\./,
  );
}

beforeEach(() => {
  _forgetRebalanceLogProblemForTests();
  _errors = [];
  _alerts = [];
  /*-
   *  TEST-ONLY: the log's error lines are captured rather than printed,
   *  through the log module's own seam, and the alert a program sets is
   *  a stand-in; both put back in `afterEach`.
   */
  _restoreSink = _setSinkForTests({
    error: (...args) => _errors.push(util.format(...args)),
  });
  sendFileProblemsTo((words, detail) => _alerts.push({ words, detail }));
});

afterEach(() => {
  _restoreSink();
  sendFileProblemsTo(null);
  if (_restoreLog !== null) _restoreLog();
  _restoreLog = null;
});

describe("a failure of the rebalance log, told", () => {
  it("is sent through the alert the program set, with the error", () => {
    const file = caseLog("[{ not json");
    readLog();
    assert.equal(_alerts.length, 1);
    assert.equal(_alerts[0].words, rebalanceLogProblem().message);
    assert.ok(_alerts[0].words.includes(file));
    assert.match(_alerts[0].detail, /JSON/);
  });

  it("is told once while its words are unchanged, as on every read of a log that stays unreadable", () => {
    caseLog("[{ not json");
    readLog();
    const first = rebalanceLogProblem();
    readLog();
    appendLog({ action: "test" });
    assert.equal(
      rebalanceLogProblem(),
      first,
      "the same problem, the same time",
    );
    assert.equal(_errors.length, 1, "logged once");
    assert.equal(_alerts.length, 1, "sent once");
  });

  it("is told again when another failure takes its place", () => {
    const file = caseLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    readLog();
    // A folder where the log should be: a read fails, then so does a write.
    fs.mkdirSync(file);
    readLog();
    assert.match(rebalanceLogProblem().message, /could not read/);
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, "[]");
    /*-
     *  TEST-ONLY global swap: the log's write fails as on a full disk.
     *  Put back in the `finally` below, immediately after the call.
     */
    const savedWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    };
    try {
      appendLog({ action: "test" });
    } finally {
      fs.writeFileSync = savedWrite;
    }
    assert.match(rebalanceLogProblem().message, /could not write to/);
    assert.equal(_alerts.length, 2, "each failure sent once");
  });
});

describe("reading the rebalance log", () => {
  it("reads it at an absolute path, where it is written", () => {
    caseLog(JSON.stringify([{ newTokenId: "1" }]));
    assert.deepEqual(readLog(), [{ newTokenId: "1" }]);
    assert.equal(rebalanceLogProblem(), null);
  });

  it("reads no log yet as empty, and tells no one", () => {
    caseLog();
    assert.deepEqual(readLog(), []);
    assert.equal(rebalanceLogProblem(), null);
    assert.deepEqual(_errors, []);
  });

  it("tells the operator of a log it cannot read, as a read, never a write", () => {
    const file = caseLog("[{ not json");
    assert.deepEqual(readLog(), []);
    const problem = rebalanceLogProblem();
    assert.ok(problem !== null, "told");
    assert.ok(
      problem.message.startsWith(
        `LP Ranger could not read its rebalance log, ${file}.`,
      ),
      problem.message,
    );
    assert.doesNotMatch(problem.message, /write/);
    assertAdvice(problem.message);
    assert.equal(typeof problem.at, "number");
    assert.equal(_errors.length, 1, "logged once");
    assert.match(_errors[0], /could not read its rebalance log/);
  });

  it("tells of a file that holds no list of rebalances, as a read", () => {
    caseLog(JSON.stringify({ entries: [] }));
    assert.deepEqual(readLog(), []);
    assert.match(rebalanceLogProblem().message, /could not read/);
  });
});

describe("the status answer", () => {
  /*-
   *  The real status handler, as test/start-up-syncing.test.js builds
   *  it, over no position.
   */
  const handler = createApiStatusHandler({
    config,
    diskConfig: { global: {}, positions: {} },
    positionMgr: {
      runningCount: () => 0,
      getAll: () => [],
      getPoolDailyCounts: () => ({}),
    },
    walletManager: { getAddress: () => null },
    routeHandlers: { getPositionScanStatus: () => null },
    buildStatusPositions: () => ({}),
    buildGasStatusPayload: async () => ({}),
    actualGasCostUsd: async () => 0,
    getLpProviderDisplayName: () => "9mm v3",
    managedKeys,
    primaryRouteLabel,
    moralisEnabledIn,
    jsonResponse: (res, _status, body) => {
      res.body = body;
    },
  });

  /** What the status answer's `global` carries now. */
  async function globalNow() {
    const res = {};
    await handler({}, res);
    return res.body.global;
  }

  it("carries the last failed read or write, for every dashboard tab", async () => {
    assert.equal((await globalNow()).rebalanceLogProblem, null, "none yet");
    caseLog("[{ not json");
    readLog();
    assert.deepEqual(
      (await globalNow()).rebalanceLogProblem,
      rebalanceLogProblem(),
    );
  });
});

describe("writing the rebalance log", () => {
  it("creates the log when there is none yet, and appends to it", () => {
    const file = caseLog();
    appendLog({ action: "test", value: 123n });
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "test");
    assert.equal(entries[0].value, "123", "a BigInt written as its digits");
    assert.ok(entries[0].loggedAt);
    appendLog({ action: "test2" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 2);
    assert.equal(rebalanceLogProblem(), null);
  });

  it("never writes over a log it cannot read, and tells it as a read", () => {
    const file = caseLog("[{ not json");
    appendLog({ action: "test" });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "[{ not json",
      "left as it was",
    );
    const { message } = rebalanceLogProblem();
    assert.match(message, /could not read its rebalance log/);
    assert.doesNotMatch(message, /write/);
  });

  it("tells of a log it cannot read whose path is a folder, never throwing", () => {
    const file = caseLog();
    fs.mkdirSync(file);
    assert.doesNotThrow(() => appendLog({ action: "test" }));
    assert.match(rebalanceLogProblem().message, /could not read/);
  });

  it("tells the operator of a write that fails, as a write, never throwing", () => {
    const file = caseLog(JSON.stringify([{ action: "earlier" }]));
    /*-
     *  TEST-ONLY global swap: the log's write fails as on a full disk.
     *  Put back in the `finally` below, immediately after the call.
     */
    const savedWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    };
    try {
      assert.doesNotThrow(() => appendLog({ action: "test" }));
    } finally {
      fs.writeFileSync = savedWrite;
    }
    const { message } = rebalanceLogProblem();
    assert.ok(
      message.startsWith(
        `LP Ranger could not write to its rebalance log, ${file}.`,
      ),
      message,
    );
    assertAdvice(message);
    assert.doesNotMatch(message, /ENOSPC/, "the dialog names no error");
    assert.match(_errors[0], /ENOSPC/, "the log line does");
  });
});
