/**
 * @file src/server-pid.js
 * @module server-pid
 * @description
 * PID-file lifecycle for the LP Ranger server.  On startup the server writes
 * its process id to `tmp/lp-ranger.pid`, and the file goes when the process
 * does: a signal-driven shutdown, `POST /api/stop-when-all-clear` and an
 * uncaught error all end in Node's `exit` event, which removes it.  Only a
 * process killed outright leaves it behind, since that runs no code at
 * all.  `npm stop`
 * (scripts/stop.js) reads the PID and sends SIGTERM — the same graceful
 * shutdown path as Ctrl+C — so an operator can stop the server without
 * switching to its terminal or hunting the process by port.
 *
 * Every function is defensive: a PID-file failure must never crash startup or
 * block shutdown.  The file lives under `tmp/` (gitignored, ephemeral) and is
 * not sensitive — it holds only the OS process id.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("./log");

/*- Default path, relative to process.cwd() when not absolute — the server and
 *  scripts/stop.js both run from the project root, so they agree on it. */
const _DEFAULT_PATH = "tmp/lp-ranger.pid";

/** Resolve the PID-file path against cwd if it's relative. */
function _resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.filePath]  Override the default path (tests).
 * @returns {string}  Absolute path of the PID file.
 */
function getPidFilePath(opts) {
  return _resolvePath((opts && opts.filePath) || _DEFAULT_PATH);
}

/**
 * Write the current process id to the PID file, and remove the file again
 * when this process exits.  Logs a one-line confirmation (standard
 * formatting) on success.  Never throws.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  Override the default path (tests).
 * @returns {boolean}  True if the file was written.
 */
function writePidFile(opts) {
  const filePath = getPidFilePath(opts);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(process.pid) + "\n");
    process.once("exit", () => _removeIfOwn(filePath));
    log.info(
      "[server-pid] Wrote PID %d to %s (stop with `npm stop`)",
      process.pid,
      filePath,
    );
    return true;
  } catch {
    /*- A PID-file write failure must not abort startup. */
    return false;
  }
}

/**
 * The `exit` listener `writePidFile` installs.  Removes the file only
 * while it still names this process, so an exiting server never deletes
 * the file a newer one has written.  Synchronous, as an `exit` listener
 * must be.
 */
function _removeIfOwn(filePath) {
  try {
    if (readPid({ filePath }) === process.pid) fs.rmSync(filePath);
  } catch {
    // Gone already; nothing to remove.
  }
}

/**
 * Remove the PID file if present, whichever process it names.  For
 * `npm stop`, clearing a file its server can no longer remove.  Never
 * throws.
 * @param {object} [opts]
 * @param {string} [opts.filePath]  Override the default path (tests).
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
 * @param {string} [opts.filePath]  Override the default path (tests).
 * @returns {number|null}
 */
function readPid(opts) {
  const filePath = getPidFilePath(opts);
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

module.exports = {
  writePidFile,
  removePidFile,
  readPid,
  getPidFilePath,
  _DEFAULT_PATH, // exported for tests
};
