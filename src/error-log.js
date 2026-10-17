/**
 * @file src/error-log.js
 * @module error-log
 * @description
 * Catastrophic-failure diary.  Appends structured entries to the file
 * logging.json names as `errorLogPath`, `logs/error.log` as shipped
 * (next to the diagnostic `lp-ranger.log` produced by
 * `src/log-file.js`) so the operator has a record of every catastrophic
 * failure in the CURRENT session that would otherwise be swallowed by a
 * silent `catch`.  The file is DELETED on each startup (`resetErrorLog`,
 * called from server.js / bot.js) — no rotation, no archive — so no stale
 * error from a previous run ever lingers; any still-current problem is
 * re-logged by the scans on the next run, and self-healing entries clear
 * via `clearErrorLog`.
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
const { log } = require("./log");
const { loadMergedDefaults } = require("./load-merged-defaults");

/**
 * Read where the file lives: `errorLogPath` in logging.json, beside the
 * diagnostic log's own path, so operators have one place to look.
 * Relative to process.cwd() when not absolute, the resolution rule
 * src/log-file.js applies too.
 *
 * Refused at load rather than written around: every other function here
 * swallows its own failures, so a path that cannot work would otherwise
 * lose every record without a word.
 *
 * @returns {string} The configured path.
 * @throws {Error} When the setting is not a non-empty string.
 */
function _configuredPath() {
  const p = loadMergedDefaults("logging.json").errorLogPath;
  if (typeof p === "string" && p.length > 0) return p;
  throw new Error(
    "[error-log] logging.json → errorLogPath must be a file path; " +
      `it is ${JSON.stringify(p)}.`,
  );
}

const _DEFAULT_PATH = _configuredPath();

/** Resolve the error log path against cwd if it's relative. */
function _resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Append one catastrophic-failure entry to the error log.
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
 *   Override the configured path.  Used by tests.
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

/**
 * Remove every entry whose text contains `matchSubstring`, rewriting the
 * file without them.  Purpose-built for self-healing errors: when a
 * transient/fixable failure (e.g. a token's decimals becoming readable
 * again, or the operator entering a manual override) is resolved, the app
 * clears its matching entries so a stale error never lingers in the durable
 * record.  The caller tags such entries with a stable scope substring (e.g.
 * `[token-decimals] scope=<token0_token1_fee>`) at write time and passes the
 * same substring here.
 *
 * Entries are split on the four-blank-line separator that `writeErrorLog`
 * writes between records.  Never throws — a clear failure must not cascade;
 * returns false when the file is missing, nothing matched, or the write
 * failed, and true when at least one entry was removed.
 *
 * @param {string} matchSubstring  Substring identifying entries to remove.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  Override the default path (tests).
 * @returns {boolean}  True if the file was rewritten with entries removed.
 */
function clearErrorLog(matchSubstring, opts) {
  if (
    matchSubstring === undefined ||
    matchSubstring === null ||
    matchSubstring === ""
  )
    return false;
  const filePath = _resolvePath((opts && opts.filePath) || _DEFAULT_PATH);
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf8");
    /*- Split on the four-blank-line separator writeErrorLog prepends. The
     *  leading split element is "" (content before the first entry); drop it
     *  along with any entry containing the match substring. */
    const kept = content
      .split("\n\n\n\n")
      .filter((entry) => entry.length > 0 && !entry.includes(matchSubstring));
    const rebuilt = kept.length > 0 ? "\n\n\n\n" + kept.join("\n\n\n\n") : "";
    if (rebuilt === content) return false; // nothing removed → no rewrite
    fs.writeFileSync(filePath, rebuilt);
    return true;
  } catch {
    /*- Never throw from the error-record path — a clear failure is non-fatal. */
    return false;
  }
}

/**
 * Delete the error.log at process startup so each run begins clean — no stale
 * entries from a previous session linger (any still-current problem is
 * re-logged by the scans on the next run; self-healing entries also clear via
 * `clearErrorLog`).  No rotation, no archive.  Logs a one-line confirmation to
 * the console (standard formatting) on a successful deletion.  Never throws.
 *
 * Call ONLY from the direct-execution startup path of server.js / bot.js
 * (inside their `require.main === module` guards) so tests that merely import
 * those modules never delete the operator's error.log.
 *
 * @param {object} [opts]
 * @param {string} [opts.filePath]  Override the default path (tests).
 * @returns {boolean}  True if a file existed and was deleted.
 */
function resetErrorLog(opts) {
  const filePath = _resolvePath((opts && opts.filePath) || _DEFAULT_PATH);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath);
    log.info("[error-log] Cleared previous error.log on startup: %s", filePath);
    return true;
  } catch {
    /*- Never throw from the error-record path — a reset failure is non-fatal. */
    return false;
  }
}

module.exports = {
  writeErrorLog,
  clearErrorLog,
  resetErrorLog,
  getErrorLogPath,
  _DEFAULT_PATH, // exported for tests
};
