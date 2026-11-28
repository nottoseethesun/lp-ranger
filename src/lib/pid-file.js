/**
 * @file src/lib/pid-file.js
 * @module pid-file
 * @description
 * The PID files of LP Ranger's two programs. The server writes its
 * process id to `tmp/lp-ranger.pid` once it holds its port, and the
 * headless bot to `tmp/lp-ranger-bot.pid` as it starts. Each file goes
 * when its process does: a signal-driven shutdown, the held stop
 * (src/lib/stop-when-all-clear.js) and an uncaught error all end in
 * Node's `exit` event, which removes it. Only a process killed outright
 * leaves it behind, since that runs no code at all.
 * `npm stop` and `npm run gentle-stop` read the server's
 * (scripts/stop.js, scripts/gentle-stop.js), so an operator can stop the
 * server without switching to its terminal or hunting the process by
 * port. `npm run delete-all-caches-and-logs`, and
 * `npm run build-and-start -- --delete-all-caches-and-logs`, read both,
 * to stop whichever program runs before they delete anything
 * (scripts/delete-all-caches-and-logs.js).
 * No function throws: a failure is told, as every caught file failure is
 * (src/lib/file-problem.js). The files live under `tmp/` (gitignored,
 * ephemeral) and are not sensitive: each holds only the OS process id.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("./log");
const { tellFileProblem } = require("./file-problem");

/*- Each program's file, relative to process.cwd() — every program and
 *  script runs from the install folder, so they agree on it. */
const SERVER_PID_FILE = "tmp/lp-ranger.pid";
const BOT_PID_FILE = "tmp/lp-ranger-bot.pid";

/** Resolve the PID-file path against cwd if it's relative. */
function _resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath]  The program's file; the server's
 *   unless given.
 * @returns {string}  Absolute path of the PID file.
 */
function getPidFilePath(opts) {
  return _resolvePath((opts && opts.filePath) || SERVER_PID_FILE);
}

/**
 * Write the current process id to the PID file, and remove the file again
 * when this process exits.  Logs a one-line confirmation (standard
 * formatting) on success.  Never throws.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  The program's file; the server's
 *   unless given.
 * @param {string} [opts.howToStop]  How the operator stops the program,
 *   for the confirmation.
 * @returns {boolean}  True if the file was written.
 */
function writePidFile(opts) {
  const filePath = getPidFilePath(opts);
  const howToStop =
    (opts && opts.howToStop) ||
    "`npm run gentle-stop`, or `npm stop` to force it";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(process.pid) + "\n");
    process.once("exit", () => _removeIfOwn(filePath));
    log.info(
      "[pid-file] Wrote PID %d to %s (stop with %s)",
      process.pid,
      filePath,
      howToStop,
    );
    return true;
  } catch (err) {
    tellFileProblem({ doing: "write to", file: filePath, err });
    return false;
  }
}

/**
 * The `exit` listener `writePidFile` installs.  Removes the file only
 * while it still names this process, so an exiting program never deletes
 * the file a newer one has written.  Synchronous, as an `exit` listener
 * must be.
 */
function _removeIfOwn(filePath) {
  try {
    if (readPid({ filePath }) === process.pid) fs.rmSync(filePath);
  } catch (err) {
    // Gone already is nothing to remove; any other failure is told.
    tellFileProblem({ doing: "delete", file: filePath, err });
  }
}

/**
 * Remove the PID file if present, whichever process it names.  For
 * `npm stop`, clearing a file its server can no longer remove.  Never
 * throws.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  The program's file; the server's
 *   unless given.
 * @returns {boolean}  True if a file existed and was removed.
 */
function removePidFile(opts) {
  const filePath = getPidFilePath(opts);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID from the file.  Returns a positive integer, or null when the
 * file is missing, empty, or malformed.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  The program's file; the server's
 *   unless given.
 * @returns {number|null}
 */
function readPid(opts) {
  const filePath = getPidFilePath(opts);
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    // No file is no program; one there that cannot be read is told.
    tellFileProblem({ doing: "read", file: filePath, err });
    return null;
  }
}

module.exports = {
  writePidFile,
  removePidFile,
  readPid,
  getPidFilePath,
  SERVER_PID_FILE,
  BOT_PID_FILE,
};
