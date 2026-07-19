/**
 * @file src/error-log.js
 * @module error-log
 * @description
 * Catastrophic-failure diary.  Appends structured entries to
 * `logs/error.log` (next to the diagnostic `lp-ranger.log` produced by
 * `src/log-file.js`) so the operator has a single durable record of
 * every catastrophic failure that would otherwise be swallowed by a
 * silent `catch` — even after the process restarts and the terminal
 * scroll-back is gone.
 *
 * Reserved for CATASTROPHIC failures only.  Not for general debug, not
 * for handled retries, not for expected transient errors.  The one
 * current caller is `_recordScanFailure` in `src/bot-recorder-lifetime.js`,
 * which fires when the initial pool-wide lifetime scan aborts before
 * anything is persisted — the failure mode that produced the July-2026
 * $11.63-vs-$255.50 Fees Compounded discrepancy on Prod.
 *
 * Entry format:
 *
 *   <four blank lines>
 *   [YYYY-MM-DDTHH:MM:SS.sssZ] <context line>
 *   <err.stack>
 *
 * The four-line separator is by design: the file is meant for humans
 * scanning back through history, and a huge gap between entries makes
 * a new entry unmissable when the file is opened for the first time
 * in months.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/*- Default file path.  Same directory as the diagnostic log so
 *  operators only have one place to look (`logs/`).  Relative to
 *  process.cwd() when not absolute — matches the resolution rule in
 *  src/log-file.js. */
const _DEFAULT_PATH = "logs/error.log";

/** Resolve the error log path against cwd if it's relative. */
function _resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Append one catastrophic-failure entry to `logs/error.log`.
 *
 * Never throws — a filesystem failure while trying to record another
 * failure must not cascade.  Silently no-ops if the file system rejects
 * the append (disk full, permissions, etc.) and returns false so the
 * caller can log a warning if it wants; the primary error handling
 * path is completely independent of whether the on-disk record made it.
 *
 * @param {Error} err
 *   The catastrophic error.  `err.stack` is the primary payload.
 *   A non-Error value is coerced via String() and gets a placeholder
 *   stack line.
 * @param {string} [context]
 *   Optional one-line context string (position identity, blockchain,
 *   whatever is relevant).  Rendered on the same line as the timestamp.
 * @param {object} [opts]
 * @param {string} [opts.filePath]
 *   Override the default `logs/error.log` path.  Used by tests.
 * @returns {boolean}
 *   True if the append succeeded, false otherwise.
 */
function writeErrorLog(err, context, opts) {
  const filePath = _resolvePath((opts && opts.filePath) || _DEFAULT_PATH);
  const ts = new Date().toISOString();
  const ctxLine = context ? String(context) : "(no context)";
  const stack =
    err && typeof err === "object" && typeof err.stack === "string"
      ? err.stack
      : String(err);
  /*- Four blank lines BEFORE the entry.  Deliberately not after — the
   *  gap belongs to the new entry so the file's tail always reads as
   *  "here is the latest incident" rather than trailing whitespace. */
  const body = "\n\n\n\n" + "[" + ts + "] " + ctxLine + "\n" + stack + "\n";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, body);
    return true;
  } catch {
    /*- Never throw from inside the error path.  A logging failure must
     *  not itself cascade into another catastrophic error. */
    return false;
  }
}

/**
 * @returns {string} The absolute path where `writeErrorLog` would write
 *   with default options.  Used by the dashboard alert to tell the user
 *   where to look, and by the reload-position endpoint docs.
 */
function getErrorLogPath() {
  return _resolvePath(_DEFAULT_PATH);
}

module.exports = {
  writeErrorLog,
  getErrorLogPath,
  _DEFAULT_PATH, // exported for tests
};
