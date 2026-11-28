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
 * every file failure is (src/lib/file-problem.js), which stops LP Ranger
 * (src/lib/stop-on-file-problem.js), in the log and the Telegram alert
 * for other errors. The words say whether reading or writing failed, why
 * (from the error: its permissions, a full disk, content that is not a
 * log LP Ranger writes) and what to do about that, then restarting LP
 * Ranger and reloading the position, and should the app still not work,
 * removing the log with every other cache and log
 * (`npm run build-and-start -- --delete-all-caches-and-logs`, or
 * `npm run delete-all-caches-and-logs` for the headless bot, which starts
 * nothing after; scripts/delete-all-caches-and-logs.js) (the user's
 * designs, 2026-11-27 and 2026-11-28).
 * Nothing here repairs the log. Until the stop ends the process, a log
 * that could not be read is never written, so its entries are not written
 * over, and a read answers no entries.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { bigIntReplacer } = require("../lib/bigint-json");
const { tellFileProblem } = require("../lib/file-problem");

/**
 * The log's file, resolved as every read and write resolves it, so a log
 * set to an absolute path is read where it is written.
 * @returns {string}
 */
function _file() {
  return path.resolve(config.rebalanceLogPath());
}

/*- The steps the operator is given after the advice every file failure
 *  carries (src/lib/file-problem.js), in the user's words. */
const _STEPS = Object.freeze([
  "1. Restart LP Ranger: its server (or headless bot) and the web browser.",
  "2. In the dashboard, open Settings → Reload Current Position.",
  "3. If the app still does not work on restart, you will need to remove " +
    "the old log: run npm run build-and-start -- " +
    "--delete-all-caches-and-logs, which removes it with all of LP " +
    "Ranger's other caches and logs. If you run the headless bot, run " +
    "npm run delete-all-caches-and-logs instead, which starts nothing " +
    "after, then npm run bot.",
]);

/**
 * Tell the operator that `doing` the log failed, as every file failure
 * is told (src/lib/file-problem.js), with the log's own steps.
 * @param {string} doing  "read" or "write to".
 * @param {string} file  The log's file.
 * @param {{message: string, code?: string}} err  What failed.
 */
function _tell(doing, file, err) {
  tellFileProblem({
    doing,
    file,
    err,
    what: `its rebalance log, ${file}`,
    then: _STEPS,
  });
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
  _tell("read", file, {
    message: "it holds no list of rebalances",
    invalidContent: true,
  });
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
 * its record-keeping goes on (src/bot/bot-cycle.js) while LP Ranger stops.
 * A failure is told, and a log that could not be read is left as it is.
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

module.exports = { readLog, appendLog };
