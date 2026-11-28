"use strict";

/**
 * @file src/bot/rebalance-log.js
 * @module rebalance-log
 * @description
 * The rebalance log, where `config.rebalanceLogPath()` puts it
 * (`app-data/rebalance_log.json` as shipped): one entry per rebalance,
 * written as the rebalance succeeds. Every read and write the bot and the
 * server make of it is here; the bookkeeping report in util/ reads it
 * with its own reader. The bot seeds each pool's rebalances today from it
 * as it starts; a scan pass with Rebalance entries still waiting for
 * their Activity Log figures, as after a rebalance or Reload Current
 * Position, takes back what it logged of each; and a closed position's
 * history reads what it logged of that position.
 *
 * There being no log yet is no error: it reads as empty, and the first
 * rebalance creates it. Any other failure to read or write it is told as
 * every file failure is (src/lib/file-problem.js), in the log and the
 * Telegram alert for other errors, once while its words are unchanged,
 * and kept until the process ends (`rebalanceLogProblem`), so every
 * status answer carries it and each dashboard tab shows it. The words
 * say only whether reading or writing failed, not why, and advise
 * checking the file's permissions and whether the disk is full, then
 * restarting LP Ranger and reloading the position, and should the app
 * still not work, removing the log with every other cache and log
 * (`npm run build-and-start -- --delete-all-caches-and-logs`,
 * scripts/delete-all-caches-and-logs.js) (the user's design,
 * 2026-11-27). Nothing here repairs the log. A log that could not be
 * read is never written, so its entries are not written over.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { bigIntReplacer } = require("../lib/bigint-json");
const {
  tellFileProblem,
  _forgetToldFileProblemsForTests,
} = require("../lib/file-problem");

/*- The last failed read or write of the log, or null: what the operator
 *  is told, and when. Kept until the process ends, since the remedy
 *  begins with a restart. */
let _problem = null;

/**
 * The log's file, resolved as every read and write resolves it, so a log
 * set to an absolute path is read where it is written.
 * @returns {string}
 */
function _file() {
  return path.resolve(config.rebalanceLogPath());
}

/*- The steps the operator is given after the advice every file failure
 *  carries (src/lib/file-problem.js). */
const _STEPS = Object.freeze([
  "1. Restart LP Ranger: its server (or headless bot) and the web browser.",
  "2. In the dashboard, open Settings → Reload Current Position.",
  "3. If the app still does not work on restart, you will need to remove " +
    "the old log: run npm run build-and-start -- " +
    "--delete-all-caches-and-logs, which removes it with all of LP " +
    "Ranger's other caches and logs.",
]);

/**
 * Tell the operator that `doing` the log failed: told as every file
 * failure is (src/lib/file-problem.js), in the log and the Telegram alert
 * for other errors, and kept for the status answers. A failure told
 * already, in the same words, is not told again: a log that stays
 * unreadable fails on every read, and a rebuild reads it once per closed
 * position, so each tab would show the dialog anew every few seconds.
 * Another failure is told, and replaces it.
 * @param {string} doing  "read" or "write to".
 * @param {string} file  The log's file.
 * @param {{message: string, code?: string}} err  What failed.
 */
function _tell(doing, file, err) {
  const words = tellFileProblem({
    doing,
    file,
    err,
    what: `its rebalance log, ${file}`,
    then: _STEPS,
  });
  if (words !== null) _problem = { message: words, at: Date.now() };
}

/**
 * The log's entries: [] when there is no log yet, or null when it could
 * not be read, which is told. A file that holds no list of entries could
 * not be read either.
 * @param {string} file  The log's file.
 * @returns {Array<object>|null}
 */
function _entries(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    _tell("read", file, err);
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  _tell("read", file, { message: "it holds no list of rebalances" });
  return null;
}

/**
 * The log's entries; [] when there is no log yet, or when it could not
 * be read, which is told.
 * @returns {Array<object>}
 */
function readLog() {
  const file = _file();
  return _entries(file) ?? [];
}

/**
 * Append a rebalance's result to the log, creating the log when there is
 * none yet. Never throws: the rebalance is made by then, and the rest of
 * its record-keeping goes on (src/bot/bot-cycle.js). A failure is told,
 * and a log that could not be read is left as it is.
 * @param {object} result  The rebalance's result.
 */
function appendLog(result) {
  const file = _file();
  const entries = _entries(file);
  if (entries === null) return;
  entries.push({ ...result, loggedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries, bigIntReplacer, 2));
  } catch (err) {
    _tell("write to", file, err);
  }
}

/**
 * The last failed read or write of the log since the process started, or
 * null: the words for the operator, its paragraphs apart by a blank line,
 * and when it failed, in ms. Every status answer carries it
 * (src/bot/status-report.js), and the dashboard shows each failure once
 * (src/client/web/js/dashboard-rebalance-log-notice.js).
 * @returns {{message: string, at: number}|null}
 */
function rebalanceLogProblem() {
  return _problem;
}

/**
 * Forget the last failure, so a test starts with none.
 * @returns {void}
 */
function _forgetRebalanceLogProblemForTests() {
  _problem = null;
  _forgetToldFileProblemsForTests();
}

module.exports = {
  readLog,
  appendLog,
  rebalanceLogProblem,
  _forgetRebalanceLogProblemForTests,
};
