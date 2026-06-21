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
 * The default path when neither CLI nor config supplies one is
 * `app-config/lp-ranger.log`.  Called from server.js and bot.js as the
 * very first executable statement after `"use strict"`.
 */

"use strict";

const { enableLogFile } = require("./log-file");
const { loadMergedDefaults } = require("./load-merged-defaults");

/*- Default path when neither --log-file nor logging.json supplies one.
 *  Relative to process.cwd() — src/log-file.js resolves it via
 *  path.resolve. */
const _DEFAULT_PATH = "app-config/lp-ranger.log";

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
 * Run the boot wiring.  Inspects argv + logging.json and enables
 * log-to-file teeing when either source opts in.
 * @returns {string | null}  Absolute path of the active log file,
 *   or null when log-to-file remains disabled.
 */
function bootLogFile() {
  const cli = _parseCliFlag(process.argv.slice(2));
  const cfg = _readLoggingConfig();
  const enable = cli.present || cfg.enabled;
  if (!enable) return null;
  const filePath = cli.pathArg || cfg.path || _DEFAULT_PATH;
  return enableLogFile(filePath);
}

module.exports = {
  bootLogFile,
  _parseCliFlag, // exported for tests
  _readLoggingConfig, // exported for tests
  _DEFAULT_PATH, // exported for tests
};
