#!/usr/bin/env node
/**
 * @file scripts/clean.js
 * @description
 * Returns the install to the state a fresh clone is in. Backs both
 * `npm run clean` and `npm run dev-clean` (`--dev`), and
 * `npm run clean:log` (`--log`), which empties the diagnostic log alone.
 *
 * The log files are wherever logging.json puts them, an operator's
 * override included: the diagnostic log, the error log, and the error log
 * `npm run check` keeps beside it. Each is deleted or emptied only when
 * it lies inside the install folder.
 *
 * **`clean` must leave nothing behind.** It therefore names no cache
 * files of its own: `clear-blockchain-scan-cache.js` owns the
 * definition of "the scan cache", and a cache added later is covered
 * here without a second list to update. A hand-written list is worse
 * than it looks, because a stale one still reports success — the
 * command claims a full reset and leaves a warm cache, which is the
 * condition it exists to remove.
 *
 * `dev-clean` is the same run with three price/timing caches preserved,
 * because re-fetching them costs third-party API quota and they are not
 * blockchain-derived. It shares this file rather than being a near-copy
 * for the same reason.
 *
 * Why a script rather than an inline npm script: the two commands are
 * ~900 characters each, far past the project's 100-character threshold
 * for inlining, and a near-copy of one in the other is the duplication
 * this file exists to avoid.
 *
 * Usage:
 *   node scripts/clean.js          # full reset
 *   node scripts/clean.js --dev    # keep price/timing caches
 *   node scripts/clean.js --log    # the diagnostic log only
 *   node scripts/clean.js --help   # what each does
 *
 * Any other argument is refused before anything is stopped or deleted.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  clearScanCache,
  waitForServerExit,
  human,
} = require("./clear-blockchain-scan-cache");
const { loadMergedDefaults } = require("../src/load-merged-defaults");
const { checkErrorLogPath } = require("./_check-error-log");

const ROOT = path.resolve(__dirname, "..");

/*- Caches `dev-clean` keeps: none is derived from chain, and all three
 *  cost third-party API quota to refill. */
const DEV_PRESERVE = [
  "historical-price-cache.json",
  "block-time-cache.json",
  "gecko-pool-cache.json",
];

/*- Operator state the app writes. Absent in a fresh clone. */
const STATE_FILES = [
  "app-config/user-configurable/bot-config.json",
  "app-config/user-configurable/bot-config.backup.json",
  "app-config/user-configurable/api-keys.json",
  "app-data/rebalance_log.json",
  "app-data/position-records.json",
  "app-data/position-records.backup.json",
];

/*- Written by `npm run build`; the prestart guard
 *  (scripts/check-build-artifacts.js) names them and the fix if the
 *  server is started without them. All four are gitignored, so a fresh
 *  clone does not have them either. */
const BUILD_ARTIFACTS = [
  "public/disclosure-content.js",
  "public/ui-tokens.css",
];
const BUILD_DIRS = ["public/dist", "public/fonts"];

/*-
 *  Log output, where logging.json puts it with any override applied.
 *  The error log is emptied at startup anyway, but a reset should not
 *  leave the previous install's stack traces behind.
 */
const _LOGGING = loadMergedDefaults("logging.json");

/** Whether logging.json names a file at `p`: an empty path names none. */
function _isFilePath(p) {
  return typeof p === "string" && p.trim() !== "";
}

/**
 * The log files `npm run clean` removes, from logging.json's settings:
 * the diagnostic log at `path`, the error log at `errorLogPath`, and the
 * error log `npm run check` keeps beside it. A path left empty names no
 * file; an empty `path` is how log-to-file is switched off.
 * @param {{path?: *, errorLogPath?: *}} logging
 * @returns {string[]}
 */
function logFilesFrom(logging) {
  const files = [logging.path, logging.errorLogPath].filter(_isFilePath);
  if (_isFilePath(logging.errorLogPath))
    files.push(checkErrorLogPath(logging.errorLogPath));
  return files;
}

const LOG_FILES = logFilesFrom(_LOGGING);

/*- Test/report output, not app state, but equally absent on a clone. */
const REPORT_DIRS = ["test/report-artifacts"];

/** Delete a file if present. @returns {boolean} whether it existed. */
function _unlink(abs) {
  try {
    fs.unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Delete a file of the install's if present. @returns {boolean} */
function rmFile(rel) {
  return _unlink(path.join(ROOT, rel));
}

/**
 * Whether a path, relative to the install folder unless absolute, lies
 * inside the install folder. A log path an operator has pointed outside
 * it, at a system log directory say, is theirs to manage, so no clean
 * deletes there.
 * @param {string} p
 * @param {string} [root]  The install folder; this one unless a test
 *   points elsewhere.
 * @returns {boolean}
 */
function insideInstall(p, root = ROOT) {
  const rel = path.relative(root, path.resolve(root, p));
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}

/**
 * Delete the configured log files that lie inside the install folder.
 * @param {string[]} files  Paths from logging.json.
 * @param {string} [root]  As for `insideInstall`.
 * @returns {{removed: string[], outside: string[]}} What was deleted,
 *   and what was left alone for lying outside the install folder.
 */
function rmLogFiles(files, root = ROOT) {
  const removed = [];
  const outside = [];
  for (const f of files) {
    if (!insideInstall(f, root)) outside.push(f);
    else if (_unlink(path.resolve(root, f))) removed.push(f);
  }
  return { removed, outside };
}

/**
 * Empty a file where it is. A running server keeps the diagnostic log
 * open and appends to it, so it goes on writing into the same file,
 * from its start. Removing the file instead would leave the server
 * writing into one nothing can reach, still taking disk, until it
 * restarts.
 * @param {string} abs
 * @returns {boolean} Whether there was a file to empty.
 */
function _emptyFile(abs) {
  try {
    fs.truncateSync(abs, 0);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/** Say which log files were left alone, and why. */
function reportOutside(outside) {
  for (const f of outside)
    console.log(
      `[clean] Not deleted: ${f} is outside the install folder. ` +
        "Delete it yourself if you want it gone.",
    );
}

/**
 * `npm run clean:log`: empty the diagnostic log, where logging.json puts
 * it, and touch nothing else. It may run while the server runs, on a
 * schedule say, since the file is emptied in place (`_emptyFile`).
 * @param {object} [o]  Test seams; the install's own otherwise.
 * @param {*} [o.logPath]  logging.json → path.
 * @param {string} [o.root]  As for `insideInstall`.
 */
function cleanDiagnosticLog({ logPath = _LOGGING.path, root = ROOT } = {}) {
  if (!_isFilePath(logPath)) {
    console.log("No log file to clear: logging.json → path is empty.");
    return;
  }
  if (!insideInstall(logPath, root)) {
    reportOutside([logPath]);
    return;
  }
  if (_emptyFile(path.resolve(root, logPath)))
    console.log(`Cleared ${logPath}`);
  else console.log(`No log to clear at ${logPath}`);
}

/** Delete a directory tree if present. @returns {boolean} */
function rmDir(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

/** Run an npm script, inheriting stdio. */
function npm(script) {
  return spawnSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit" });
}

const HELP_TEXT = `
clean — return the install to the state a fresh clone is in

USAGE
  npm run clean              Stop the server, then delete the wallet file
                             and WALLET_PASSWORD in .env, bot-config.json,
                             the api keys, the position records, the
                             rebalance log, every scan cache, the logs and
                             the build output. Rebuild before npm start.
  npm run dev-clean          The same, keeping the price, block-time and
                             Gecko caches, which cost api quota to refill.
  npm run clean:log          Empty the diagnostic log, and nothing else.
  npm run clean -- --help    Show this text.

Anything else is refused before anything is stopped or deleted.
`.trim();

/**
 * Read the arguments. Every one is checked before anything is stopped
 * or deleted, so a mistyped one, `--help` among them, can never start a
 * full reset.
 * @param {string[]} argv  The arguments after the script's name.
 * @returns {{help: boolean, dev: boolean, log: boolean, bad: (string|null)}}
 */
function parseCleanArgs(argv) {
  const out = { help: false, dev: false, log: false, bad: null };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dev") out.dev = true;
    else if (a === "--log") out.log = true;
    else if (out.bad === null) out.bad = a;
  }
  return out;
}

/**
 * Answer what stops and deletes nothing: `--help`, an argument this
 * script does not know, and `--log`.
 * @param {{help: boolean, log: boolean, bad: (string|null)}} args
 * @returns {boolean}  Whether one was answered, and the run is over.
 */
function _answerWithoutResetting(args) {
  if (args.help) {
    console.log(HELP_TEXT);
    return true;
  }
  if (args.bad !== null) {
    console.error(
      `[clean] Unrecognized argument: ${args.bad}. Nothing was stopped or deleted.\n\n${HELP_TEXT}`,
    );
    process.exitCode = 2;
    return true;
  }
  if (args.log) {
    cleanDiagnosticLog();
    return true;
  }
  return false;
}

function main() {
  const args = parseCleanArgs(process.argv.slice(2));
  if (_answerWithoutResetting(args)) return;
  const dev = args.dev;

  /*- Stop first, then WAIT. Shutdown stops every position and closes
   *  the listener, so it is not instant — clearing underneath a server
   *  still winding down would be rewritten by it. */
  spawnSync("npm", ["run", "stop"], { cwd: ROOT, stdio: "ignore" });
  const alive = waitForServerExit();
  if (alive !== null) {
    console.error(
      `[clean] LP Ranger is still running (PID ${alive}) after npm stop.\n` +
        "Nothing was deleted. Stop it and try again.",
    );
    process.exitCode = 1;
    return;
  }

  /*- Wallet + WALLET_PASSWORD, via the script that owns that. */
  const walletRes = npm("reset-wallet");
  if (walletRes.status !== 0) {
    console.error("[clean] reset-wallet failed — stopping before deleting.");
    process.exitCode = walletRes.status ?? 1;
    return;
  }

  const removed = [];
  for (const f of STATE_FILES) if (rmFile(f)) removed.push(f);
  const logs = dev ? { removed: [], outside: [] } : rmLogFiles(LOG_FILES);
  removed.push(...logs.removed);
  for (const f of BUILD_ARTIFACTS) if (rmFile(f)) removed.push(f);
  for (const d of [...BUILD_DIRS, ...REPORT_DIRS])
    if (rmDir(d)) removed.push(d);

  const cache = clearScanCache({ preserve: dev ? DEV_PRESERVE : [] });

  console.log(
    `\n[clean] ${dev ? "Dev-cleaned" : "Cleaned"}: ${removed.length} file(s)/` +
      `director(ies), plus ${cache.removed} cache file(s) (${human(cache.bytes)}).`,
  );
  for (const r of removed) console.log("    " + r);
  reportOutside(logs.outside);
  if (cache.kept.length > 0) {
    console.log(
      "[clean] Preserved for fast dev restart: " + cache.kept.join(", "),
    );
  }
  console.log(
    "[clean] Build artifacts are gone — run `npm run build` before " +
      "`npm start`.\n",
  );
}

if (require.main === module) main();

module.exports = {
  DEV_PRESERVE,
  STATE_FILES,
  BUILD_ARTIFACTS,
  BUILD_DIRS,
  LOG_FILES,
  REPORT_DIRS,
  insideInstall,
  logFilesFrom,
  rmLogFiles,
  cleanDiagnosticLog,
  parseCleanArgs,
  HELP_TEXT,
};
