"use strict";

/**
 * @file src/lib/file-problem.js
 * @module file-problem
 * @description
 * The one place a file failure LP Ranger catches and handles is told: a
 * file it could not read or write, delete or create, whatever the file
 * (the user's design, 2026-11-27). Each is told in the log, with the
 * error, and through the alert the program sets as it starts
 * (`sendFileProblemsTo`): the Telegram alert for other errors, in the
 * server and the headless bot. The words say only what LP Ranger could
 * not do to which file, not why, and advise checking the file's
 * permissions and whether the disk is full, with any further steps the
 * caller gives. A missing file is no failure of a read, a copy or a
 * delete, and is not told, unless the caller says the file must be
 * there, as one LP Ranger ships. A failure is told
 * once while its words for that file are unchanged: a file that stays
 * unreadable fails on every read. The words are recorded before they are
 * logged, so a failure of the log file's own write, which the log line
 * meets again, is not told twice.
 *
 * The program hands the alert in, rather than this module loading the
 * Telegram module, since that module loads modules that tell their own
 * file failures here. Until one is handed in, as in a tool or a test, a
 * failure is logged alone.
 */

const { log } = require("./log");

/*- The alert the program set, or null: `(words, detail) => void`. */
let _alert = null;

/*- The last words told for each file, by its path. */
const _lastTold = new Map();

/**
 * Set where file failures are sent besides the log. Called by each
 * program as it starts; null sends them nowhere else.
 * @param {((words: string, detail: string) => void)|null} alert
 */
function sendFileProblemsTo(alert) {
  _alert = alert;
}

/*- What LP Ranger was doing when a missing file is no failure: reading
 *  or copying one not there yet, deleting one not there any more. */
const _MISSING_IS_NO_FAILURE = Object.freeze(["read", "copy", "delete"]);

/**
 * Whether what failed is no failure: a file missing, for a read, a copy
 * or a delete, unless the caller says it must be there.
 * @param {string} doing
 * @param {{code?: string}} err
 * @param {boolean} missingIsNormal
 * @returns {boolean}
 */
function _isNoFailure(doing, err, missingIsNormal) {
  return (
    missingIsNormal &&
    _MISSING_IS_NO_FAILURE.includes(doing) &&
    err.code === "ENOENT"
  );
}

/**
 * Tell a file failure LP Ranger caught, once while its words for that
 * file are unchanged.
 * @param {object} p
 * @param {string} p.doing  What LP Ranger could not do: "read",
 *   "write to", "copy" or "delete".
 * @param {string} p.file  The file's path: a failure is told once by it.
 * @param {{message: string, code?: string}} p.err  What failed.
 * @param {string} [p.what]  How the operator knows the file, "its
 *   rebalance log, <path>" say; the path when not given.
 * @param {string[]} [p.then]  Steps for the operator after the advice.
 * @param {boolean} [p.missingIsNormal]  False for a file that must be
 *   there, as one LP Ranger ships: missing, it is told too.
 * @returns {string|null}  The words told now, its paragraphs apart by a
 *   blank line; null when nothing was told.
 */
function tellFileProblem({
  doing,
  file,
  err,
  what = file,
  then = [],
  missingIsNormal = true,
}) {
  if (_isNoFailure(doing, err, missingIsNormal)) return null;
  const advice =
    "Check the file's permissions, and whether the disk is full." +
    (then.length > 0 ? " Then:" : "");
  const words = [`LP Ranger could not ${doing} ${what}.`, advice, ...then].join(
    "\n\n",
  );
  if (_lastTold.get(file) === words) return null;
  _lastTold.set(file, words);
  const oneLine = words.replaceAll("\n\n", " ");
  log.error("[files] %s (%s)", oneLine, err.message);
  if (_alert !== null) _alert(words, err.message);
  return words;
}

/**
 * Forget every failure told, so a test starts with none.
 * @returns {void}
 */
function _forgetToldFileProblemsForTests() {
  _lastTold.clear();
}

module.exports = {
  sendFileProblemsTo,
  tellFileProblem,
  _forgetToldFileProblemsForTests,
};
