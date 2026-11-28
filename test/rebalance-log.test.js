"use strict";

/**
 * @file test/rebalance-log.test.js
 * @description The rebalance log's reads and writes
 *   (src/bot/rebalance-log.js), which every reader and writer of the log
 *   in the bot and the server goes through. There being no log yet is no
 *   error: it reads as empty, and the first rebalance creates it. Any
 *   other failed read or write is told as every file failure is
 *   (src/lib/file-problem.js): logged, then handed to the program's
 *   handler, which stops LP Ranger, in words that say whether reading or
 *   writing failed, why and what to do about it, then restarting LP
 *   Ranger, reloading the position and, should that not help, deleting
 *   every cache and log. Every failure
 *   is told. A write never throws, so the rebalance's record-keeping goes
 *   on while LP Ranger stops, and a log that could not be read is never
 *   written over. Each case points the log at a file of its own.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");
const { handleFileProblemsWith } = require("../src/lib/file-problem");
const { useRebalanceLog } = require("./helpers/rebalance-log");
const { readLog, appendLog } = require("../src/bot/rebalance-log");

const DIR = makeTestTempFolder("rebalance-log");

let _cases = 0;
let _restoreLog = null;
let _restoreSink = null;
let _errors = [];
let _handed = [];

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

/** The log's own steps, which every failure gives after its cause's advice. */
function assertAdvice(message) {
  assert.match(message, / Then:\n\n1\. /);
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
  // The way for the headless bot, which the build-and-start command
  // would replace with the server (the user's ruling, 2026-11-28).
  assert.match(
    message,
    /If you run the headless bot, run npm run delete-all-caches-and-logs instead, which starts nothing after, then npm run bot\./,
  );
}

/*- The words the last failure was handed on in. */
const lastWords = () => _handed.at(-1).words;

beforeEach(() => {
  _errors = [];
  _handed = [];
  /*-
   *  TEST-ONLY: the log's error lines are captured rather than printed,
   *  through the log module's own seam, and the handler a program sets
   *  (its stop) is a stand-in; both put back in `afterEach`.
   */
  _restoreSink = _setSinkForTests({
    error: (...args) => _errors.push(util.format(...args)),
  });
  handleFileProblemsWith((words, detail) => _handed.push({ words, detail }));
});

afterEach(() => {
  _restoreSink();
  handleFileProblemsWith(null);
  if (_restoreLog !== null) _restoreLog();
  _restoreLog = null;
});

describe("a failure of the rebalance log, told", () => {
  it("is handed to the program's handler, with the error", () => {
    const file = caseLog("[{ not json");
    readLog();
    assert.equal(_handed.length, 1);
    assert.ok(_handed[0].words.includes(file));
    assert.match(_handed[0].detail, /JSON/);
  });

  it("is told at every read and write that meets it", () => {
    caseLog("[{ not json");
    readLog();
    readLog();
    appendLog({ action: "test" });
    assert.equal(_handed.length, 3);
    assert.equal(_errors.length, 3);
  });
});

describe("reading the rebalance log", () => {
  it("reads it at an absolute path, where it is written", () => {
    caseLog(JSON.stringify([{ newTokenId: "1" }]));
    assert.deepEqual(readLog(), [{ newTokenId: "1" }]);
    assert.deepEqual(_handed, []);
  });

  it("reads no log yet as empty, and tells no one", () => {
    caseLog();
    assert.deepEqual(readLog(), []);
    assert.deepEqual(_handed, []);
    assert.deepEqual(_errors, []);
  });

  it("tells the operator of a log it cannot read, as a read, never a write", () => {
    const file = caseLog("[{ not json");
    assert.deepEqual(readLog(), []);
    assert.equal(_handed.length, 1, "told");
    const words = lastWords();
    assert.ok(
      words.startsWith(
        `LP Ranger could not read its rebalance log, ${file}: it is not valid JSON (`,
      ),
      words,
    );
    assert.doesNotMatch(words, /write|permission|disk is full/);
    assertAdvice(words);
    assert.equal(_errors.length, 1, "logged once");
    assert.match(_errors[0], /could not read its rebalance log/);
  });

  it("tells of a file that holds no list of rebalances, as a read, not what LP Ranger writes there", () => {
    caseLog(JSON.stringify({ entries: [] }));
    assert.deepEqual(readLog(), []);
    assert.match(
      lastWords(),
      /could not read .*: it is not what LP Ranger writes there \(it holds no list of rebalances\)\./,
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
    assert.deepEqual(_handed, []);
  });

  it("never writes over a log it cannot read, and tells it as a read", () => {
    const file = caseLog("[{ not json");
    appendLog({ action: "test" });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "[{ not json",
      "left as it was",
    );
    assert.match(lastWords(), /could not read its rebalance log/);
    assert.doesNotMatch(lastWords(), /write/);
  });

  it("tells of a log it cannot read whose path is a folder, never throwing", () => {
    const file = caseLog();
    fs.mkdirSync(file);
    assert.doesNotThrow(() => appendLog({ action: "test" }));
    assert.match(lastWords(), /could not read/);
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
    const words = lastWords();
    assert.ok(
      words.startsWith(
        `LP Ranger could not write to its rebalance log, ${file}: the disk is full.\n\nFree some space on the disk. Then:`,
      ),
      words,
    );
    assertAdvice(words);
    assert.doesNotMatch(words, /ENOSPC/, "the words in the operator's terms");
    assert.match(_errors[0], /ENOSPC/, "the log line gives Node's error too");
  });
});
