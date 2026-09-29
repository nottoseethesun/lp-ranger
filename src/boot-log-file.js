/**
 * @file src/boot-log-file.js
 * @module boot-log-file
 * @description
 * Boot wiring for the log-to-file feature.  Inspects process.argv for
 * the `--log-file [path]` CLI flag and reads `logging.json` (via the
 * layered defaults+user-override loader) for the operator-level
 * `{enabled, path}` defaults — operators override at
 * `app-config/user-configurable/logging.json`.  When either source
 * opts in, requires `./log-file` and enables teeing before any other
 * module produces output — so the file captures the version banner
 * and every startup line, not just runtime logs.
 *
 * Precedence:
 *   1. `--log-file <path>`     → enable, use <path>
 *   2. `--log-file` (no path)  → enable, use the config path (or default)
 *   3. logging.json enabled=true → enable, use config path
 *   4. (default)                  → disabled, no-op
 *
 * `--delete-pre-existing-log-file` clears whichever file the above
 * settles on, before the first byte is written. It acts only when
 * log-to-file is on, so asking for it alone cannot delete a previous
 * run's log that this run will not replace.
 *
 * The default path when neither CLI nor config supplies one is
 * `logs/lp-ranger.log`.  Called from server.js and bot.js as the
 * very first executable statement after `"use strict"`.
 */

"use strict";

const fs = require("fs");
const { enableLogFile, resolveLogFilePath } = require("./log-file");
const { loadMergedDefaults } = require("./load-merged-defaults");

/**
 * Flag that clears the log file before this run starts writing to it.
 *
 * The file is opened in append mode, so a long-lived install
 * accumulates every run in one file. An operator reproducing a fault
 * wants the file to contain that attempt and nothing else, and
 * deleting it by hand between runs is a step that gets forgotten
 * exactly when the log matters.
 */
const DELETE_FLAG = "--delete-pre-existing-log-file";

/*- Default path when neither --log-file nor logging.json supplies one.
 *  Relative to process.cwd() — src/log-file.js resolves it via
 *  path.resolve. */
const _DEFAULT_PATH = "logs/lp-ranger.log";

/*- Parse argv for the --log-file flag.  Returns {present, pathArg}.
 *  pathArg is the immediately following arg when it doesn't itself
 *  start with `--`, allowing both `--log-file path` and bare
 *  `--log-file`. */
function _parseCliFlag(argv) {
  let present = false;
  let pathArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--log-file") continue;
    present = true;
    const next = argv[i + 1];
    if (typeof next === "string" && next.length > 0 && !next.startsWith("--")) {
      pathArg = next;
    }
  }
  return { present, pathArg };
}

/*- Read logging.json via the layered loader and extract {enabled, path}.
 *  Returns defaults silently when the file is missing or malformed so
 *  the boot path never crashes on a fresh install. */
function _readLoggingConfig() {
  try {
    const obj = loadMergedDefaults("logging.json");
    if (!obj || typeof obj !== "object") return { enabled: false, path: null };
    const enabled = obj.enabled === true;
    const p = typeof obj.path === "string" && obj.path ? obj.path : null;
    return { enabled, path: p };
  } catch {
    return { enabled: false, path: null };
  }
}

/**
 * Delete the log file this run is about to open, if it is there.
 *
 * An absent file is the success case, not an error — the flag asks for
 * an empty log, and there is nothing emptier than no file. Any other
 * failure warns rather than throwing: the run is still worth having,
 * and a log that opens with a previous run's lines still in it is
 * better than no bot. The warning goes to the terminal because nothing
 * is teeing to the file yet, and it says plainly that the file was NOT
 * cleared, since reading stale lines as current is the whole failure
 * this flag exists to prevent.
 *
 * @param {string} absPath  Resolved path of the file to remove.
 * @returns {void}
 */
function _deletePreExistingLogFile(absPath) {
  try {
    fs.unlinkSync(absPath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    process.stderr.write(
      `[log-file] Could not delete ${absPath}: ${err.message}\n` +
        `[log-file] NOT cleared — this run appends to the previous one.\n`,
    );
  }
}

/**
 * Run the boot wiring.  Inspects argv + logging.json and enables
 * log-to-file teeing when either source opts in.
 * @returns {string | null}  Absolute path of the active log file,
 *   or null when log-to-file remains disabled.
 */
function bootLogFile() {
  const argv = process.argv.slice(2);
  const cli = _parseCliFlag(argv);
  const cfg = _readLoggingConfig();
  const enable = cli.present || cfg.enabled;
  if (!enable) return null;
  const filePath = cli.pathArg || cfg.path || _DEFAULT_PATH;
  /*- Only when a file is actually about to be written.  Asked for
   *  without `--log-file`, and with logging.json off, there is nothing
   *  this run will write and deleting would take away the previous
   *  run's log to no purpose. */
  if (argv.includes(DELETE_FLAG)) {
    _deletePreExistingLogFile(resolveLogFilePath(filePath));
  }
  return enableLogFile(filePath);
}

module.exports = {
  bootLogFile,
  DELETE_FLAG,
  _parseCliFlag, // exported for tests
  _readLoggingConfig, // exported for tests
  _deletePreExistingLogFile, // exported for tests
  _DEFAULT_PATH, // exported for tests
};
