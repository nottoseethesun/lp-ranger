"use strict";

/**
 * @file src/lib/file-problem.js
 * @module file-problem
 * @description
 * The one place a file failure LP Ranger catches is told: a file it could
 * not read or write, copy or delete, whatever the file (the user's design,
 * 2026-11-27). Each is told in the log, with the error, and handed to the
 * handler the program sets as it starts (`handleFileProblemsWith`). LP
 * Ranger cannot go on without its files, so the server and the headless
 * bot each stop at the first one (src/lib/stop-on-file-problem.js; the
 * user's ruling, 2026-11-27). The words say what LP Ranger could not do
 * to which file and why, from the error itself: a file error's code as
 * Node gives it (its permissions, a full or read-only disk, a folder where
 * the file should be), or JSON that is not valid; and what to do about
 * that cause, with any further steps the caller gives (the user's ruling,
 * 2026-11-27: no "permissions or disk full" where that is not the case).
 * A missing file is no failure of a read, a copy or a delete, and is not
 * told, unless the caller says the file must be there, as one LP Ranger
 * ships.
 *
 * Every failure is told, the ones met while the program stops included,
 * as when a rebalance under way finishes. The diagnostic log stops writing
 * to its file at its own first failure (src/lib/log-file.js), so that
 * failure's log line, which would meet the same write, cannot loop.
 *
 * The program hands its handler in, rather than this module loading the
 * stop, since the modules the stop reaches tell their own file failures
 * here. Until one is handed in, as in a tool or a test, a failure is
 * logged alone.
 */

const { log } = require("./log");

/*- The program's handler, or null: `(words, detail) => void`. */
let _handler = null;

/**
 * Set what is done with each file failure besides the log: the program's
 * stop, set as it starts; null does nothing more.
 * @param {((words: string, detail: string) => void)|null} handler
 */
function handleFileProblemsWith(handler) {
  _handler = handler;
}

/*- What LP Ranger was doing when a missing file is no failure: reading
 *  or copying one not there yet, deleting one not there any more. */
const _MISSING_IS_NO_FAILURE = Object.freeze(["read", "copy", "delete"]);

/*- What each of Node's file error codes means, in the operator's words,
 *  and what to do about it. */
const _PERMISSIONS = Object.freeze({
  cause: "its permissions do not allow it",
  fix: "Check the permissions of the file and of its folder.",
});
const _BY_CODE = Object.freeze({
  EACCES: _PERMISSIONS,
  EPERM: _PERMISSIONS,
  ENOSPC: { cause: "the disk is full", fix: "Free some space on the disk." },
  EDQUOT: {
    cause: "the disk quota is used up",
    fix: "Free some space, or raise the quota.",
  },
  EROFS: { cause: "the disk is read-only", fix: "Make the disk writable." },
  EISDIR: {
    cause: "a folder is where the file should be",
    fix: "Move the folder away.",
  },
  ENOTDIR: {
    cause: "a file is where a folder on its path should be",
    fix: "Move that file away.",
  },
  EEXIST: {
    cause: "a file or folder is already where LP Ranger had to make one",
    fix: "Move it away.",
  },
  ENOENT: { cause: "it is not there", fix: "Restore the file." },
  EMFILE: {
    cause: "LP Ranger has too many files open",
    fix: "Raise the limit on open files (ulimit -n).",
  },
  ENFILE: {
    cause: "the system has too many files open",
    fix: "Close other programs, or raise the system's limit on open files.",
  },
  EIO: { cause: "the disk reported an error", fix: "Check the disk." },
  EBUSY: {
    cause: "another program is using it",
    fix: "Close the program using it.",
  },
});

/*- What to do about a file whose text is not what LP Ranger reads. */
const _CORRECT_IT =
  "Correct the file, delete it if it is a cache (LP Ranger rebuilds a " +
  "cache), or restore it from a backup.";

/**
 * What went wrong and what to do, from the error itself: a file error's
 * code, as Node gives it; JSON that does not parse, a SyntaxError; or
 * text that parses but is not what LP Ranger writes there, an error the
 * caller marks `invalidContent`. Any other error is told as Node words it.
 * An error that wraps the one met, as the shipped-defaults loader's does
 * (src/lib/load-merged-defaults.js), is told by the one it wraps
 * (`cause`), one level down.
 * @param {{message: string, code?: string, name?: string,
 *   invalidContent?: boolean, cause?: *}} wrapper
 * @returns {{cause: string, fix: string}}
 */
function _causeOf(wrapper) {
  const err = wrapper.cause instanceof Error ? wrapper.cause : wrapper;
  if (err.name === "SyntaxError")
    return { cause: `it is not valid JSON (${err.message})`, fix: _CORRECT_IT };
  if (err.invalidContent === true)
    return {
      cause: `it is not what LP Ranger writes there (${err.message})`,
      fix: _CORRECT_IT,
    };
  const known = _BY_CODE[err.code];
  if (known !== undefined) return known;
  return { cause: err.message, fix: "Check the file and the disk." };
}

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
 * Tell a file failure LP Ranger caught: in the log, then to the program's
 * handler.
 * @param {object} p
 * @param {string} p.doing  What LP Ranger could not do: "read",
 *   "write to", "copy" or "delete".
 * @param {string} p.file  The file's path.
 * @param {{message: string, code?: string}} p.err  What failed.
 * @param {string} [p.what]  How the operator knows the file, "its
 *   rebalance log, <path>" say; the path when not given.
 * @param {string[]} [p.then]  Steps for the operator after the advice.
 * @param {boolean} [p.missingIsNormal]  False for a file that must be
 *   there, as one LP Ranger ships: missing, it is told too.
 * @returns {string|null}  The words told, their paragraphs apart by a
 *   blank line; null when nothing failed.
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
  const { cause, fix } = _causeOf(err);
  const words = [
    `LP Ranger could not ${doing} ${what}: ${cause}.`,
    fix + (then.length > 0 ? " Then:" : ""),
    ...then,
  ].join("\n\n");
  log.error("[files] %s (%s)", words.replaceAll("\n\n", " "), err.message);
  if (_handler !== null) _handler(words, err.message);
  return words;
}

module.exports = { handleFileProblemsWith, tellFileProblem };
