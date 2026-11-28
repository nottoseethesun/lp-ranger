"use strict";

/**
 * @file test/stop-on-file-problem.test.js
 * @description How LP Ranger stops at a file it cannot read or write
 *   (src/lib/stop-on-file-problem.js): once, at the first failure; the
 *   alert first, with the failure's words and that it stops; then the
 *   server closes, before the bot is touched, so no request reaches a
 *   stopping bot; then nothing new starts and each position stops once its
 *   check has ended, a rebalance or compound under way finishing first;
 *   then the process exits with status 1, at once when no bot is built
 *   yet, else only once every position has stopped. A step that throws
 *   does not keep the rest from running.
 *
 *   The steps are stand-ins that record their order; the exit records its
 *   status and never ends the test process.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { _setSinkForTests } = require("../src/lib/log");
const {
  createStopOnFileProblem,
  STOPPING,
} = require("../src/lib/stop-on-file-problem");

let restoreSink;
let errors;

beforeEach(() => {
  errors = [];
  // TEST-ONLY: the log's error lines, through its seam; put back after.
  restoreSink = _setSinkForTests({
    error: (...a) => errors.push(a.join(" ")),
  });
});

afterEach(() => restoreSink());

/**
 * A stop whose steps record what ran, in order. `stopPositions` answers
 * the promise or value given.
 */
function recordingStop(stopPositionsAnswer) {
  const ran = [];
  const stop = createStopOnFileProblem({
    alert: (words, detail) => ran.push(["alert", words, detail]),
    closeServer: () => ran.push(["closeServer"]),
    markStopping: () => ran.push(["markStopping"]),
    stopPositions: () => {
      ran.push(["stopPositions"]);
      return stopPositionsAnswer;
    },
    exit: (status) => ran.push(["exit", status]),
  });
  return { stop, ran };
}

const names = (ran) => ran.map(([n]) => n);

describe("the stop at a file LP Ranger cannot read or write", () => {
  it("sends the alert, closes the server, then stops the bot, and exits 1 once every position has stopped", async () => {
    let positionsStopped;
    const stopped = new Promise((resolve) => (positionsStopped = resolve));
    const { stop, ran } = recordingStop(stopped);
    stop("LP Ranger could not read /x.", "EACCES");
    assert.deepEqual(names(ran), [
      "alert",
      "closeServer",
      "markStopping",
      "stopPositions",
    ]);
    assert.equal(ran[0][1], `LP Ranger could not read /x.\n\n${STOPPING}`);
    assert.equal(ran[0][2], "EACCES");
    // A rebalance under way: no exit until every position has stopped.
    await new Promise((r) => setImmediate(r));
    assert.equal(names(ran).includes("exit"), false, "waits for the move");
    positionsStopped();
    await stopped;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ran.at(-1), ["exit", 1]);
  });

  it("exits 1 at once when no bot is built yet, as at load", () => {
    const { stop, ran } = recordingStop(undefined);
    stop("LP Ranger could not read /x.", "EACCES");
    assert.deepEqual(ran.at(-1), ["exit", 1]);
  });

  it("acts once: a failure met while it stops is not a second stop", async () => {
    const { stop, ran } = recordingStop(Promise.resolve());
    stop("first", "e1");
    stop("second", "e2");
    await new Promise((r) => setImmediate(r));
    assert.equal(names(ran).filter((n) => n === "alert").length, 1);
    assert.equal(names(ran).filter((n) => n === "exit").length, 1);
  });

  it("goes on past a step that throws, and exits even when stopping the positions fails", async () => {
    const ran = [];
    const stop = createStopOnFileProblem({
      alert: () => {
        throw new Error("no telegram");
      },
      closeServer: () => ran.push("closeServer"),
      markStopping: () => ran.push("markStopping"),
      stopPositions: () => Promise.reject(new Error("stuck")),
      exit: (status) => ran.push(`exit ${status}`),
    });
    stop("w", "d");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ran, ["closeServer", "markStopping", "exit 1"]);
    assert.ok(errors.some((e) => e.includes("no telegram")));
    assert.ok(errors.some((e) => e.includes("stuck")));
  });

  it("says in the log that LP Ranger is stopping, and why", () => {
    const { stop } = recordingStop(undefined);
    stop("w", "d");
    assert.ok(errors.some((e) => e.includes(STOPPING)));
  });
});

describe("each program's stop at a file failure, as wired", () => {
  /*-
   *  Wiring, asserted against the source: a test that started the real
   *  server or bot would run it against the operator's files. Each hands
   *  file failures to its stop before it reads its first file, the boot
   *  log's settings, so no failure is left to go on; and fills in what
   *  the stop acts on as each part comes to be.
   */
  const fs = require("fs");
  const path = require("path");
  const source = (file) =>
    fs
      .readFileSync(path.join(__dirname, "..", "src", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it("the server: before its first file, refusing every request before the bot stops, its parts filled in as made", () => {
    const src = source("server.js");
    const handed = src.indexOf("handleFileProblemsWith(");
    assert.ok(handed > 0, "file failures handed to the stop");
    assert.ok(handed < src.indexOf("bootLogFile()"), "before the first file");
    assert.ok(handed < src.indexOf("createBot("), "before the bot is built");
    /*-
     *  The server keeps its port until the exit, so a second start fails
     *  on it while this one finishes a move: it refuses every request and
     *  closes its connections, never `server.close()`.
     */
    assert.match(
      src,
      /closeServer: \(\) => \{\s*_stopParts\.refusing = true;\s*if \(_stopParts\.server !== null\) _stopParts\.server\.closeAllConnections\(\);\s*\},/,
    );
    assert.doesNotMatch(src, /_stopParts\.server\.close\(\)/);
    assert.match(
      src,
      /async function handleRequest\(req, res\) \{\s*const \{ method, url \} = req;\s*if \(_stopParts\.refusing\) \{\s*req\.socket\.destroy\(\);\s*return;\s*\}/,
    );
    // Its wait for the positions is the bot's own, answered, never dropped.
    assert.match(
      src,
      /stopPositions: \(\) =>\s*_stopParts\.bot === null \? undefined : _stopParts\.bot\.stopAll\(\),/,
    );
    assert.match(src, /createBot\(\{[\s\S]*?\}\);\s*_stopParts\.bot = _bot;/);
    assert.match(
      src,
      /http\.createServer\(handleRequest\);\s*_stopParts\.server = server;/,
    );
    assert.match(src, /_stopParts\.alert = notifyFileProblemBeforeExit;/);
  });

  it("the headless bot: before its first file, sending no alert, waiting for its positions, its single loop's start included", () => {
    const src = source("bot.js");
    const handed = src.indexOf("handleFileProblemsWith(");
    assert.ok(handed > 0, "file failures handed to the stop");
    assert.ok(handed < src.indexOf("bootLogFile()"), "before the first file");
    assert.match(src, /alert: \(\) => \{\},/, "no Telegram alert headless");
    assert.match(src, /_stopParts\.bot = bot;/);
    assert.match(src, /_stopParts\.stopPositions = \(\) => stopPositions\(\);/);
    assert.match(src, /let stopPositions = \(\) => bot\.stopAll\(\);/);
    /*-
     *  Single-position mode: the loop's start holds its first check and
     *  scan, outside the position manager, so the stop waits for it.
     */
    assert.match(
      src,
      /stopPositions = async \(\) => \{\s*const started = await starting;\s*await Promise\.all\(\[started\.stop\(\), bot\.stopAll\(\)\]\);\s*\};/,
    );
    assert.match(src, /const starting = startBotLoop\(\{/);
  });

  it("the Telegram sender: its failure to start is caught, and only its code logged", () => {
    /*-
     *  With no 'error' listener a sender that cannot start throws, the
     *  server's guard exits at once and logs the error, the Telegram bot
     *  token in its arguments.
     */
    const src = source(
      path.join("server", "telegram-notifications", "server-shutdown.js"),
    );
    assert.match(
      src,
      /child\.on\("error", \(err\) =>\s*log\.warn\("\[server\] The Telegram sender did not start: %s", err\.code\),?\s*\);/,
    );
  });
});
