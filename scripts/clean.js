#!/usr/bin/env node
/**
 * @file scripts/clean.js
 * @description
 * Returns the install to the state a fresh clone is in. Backs both
 * `npm run clean` and `npm run dev-clean` (`--dev`), and
 * `npm run clean:log` (`--log`), which deletes the diagnostic log alone.
 *
 * The two log files are wherever logging.json puts them, an operator's
 * override included, and are deleted only when that lies inside the
 * install folder.
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
 *   node scripts/clean.js         # full reset
 *   node scripts/clean.js --dev   # keep price/timing caches
 *   node scripts/clean.js --log   # the diagnostic log only
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
 *  Log output, where logging.json puts it with any override applied:
 *  the diagnostic log's `path` and the error log's `errorLogPath`. The
 *  error log is emptied at startup anyway, but a reset should not leave
 *  the previous install's stack traces behind.
 */
const _LOGGING = loadMergedDefaults("logging.json");
const LOG_FILES = [_LOGGING.path, _LOGGING.errorLogPath];

/*- Test/report output, not app state, but equally absent on a clone. */
const REPORT_DIRS = ["test/report-artifacts"];

/** Delete a file if present. @returns {boolean} whether it existed. */
function rmFile(rel) {
  const p = path.join(ROOT, rel);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a path, relative to the install folder unless absolute, lies
 * inside the install folder. A log path an operator has pointed outside
 * it, at a system log directory say, is theirs to manage, so no clean
 * deletes there.
 * @param {string} p
 * @returns {boolean}
 */
function insideInstall(p) {
  const rel = path.relative(ROOT, path.resolve(ROOT, p));
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}

/**
 * Delete the configured log files that lie inside the install folder.
 * @param {string[]} files  Paths from logging.json.
 * @returns {{removed: string[], outside: string[]}} What was deleted,
 *   and what was left alone for lying outside the install folder.
 */
function rmLogFiles(files) {
  const removed = [];
  const outside = [];
  for (const f of files) {
    if (!insideInstall(f)) outside.push(f);
    else if (rmFile(path.relative(ROOT, path.resolve(ROOT, f))))
      removed.push(f);
  }
  return { removed, outside };
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
 * `npm run clean:log`: the diagnostic log alone, where logging.json
 * puts it. Run with the app stopped, as the manual says; nothing else
 * is touched.
 */
function cleanDiagnosticLog() {
  const { removed, outside } = rmLogFiles([_LOGGING.path]);
  reportOutside(outside);
  if (removed.length > 0) console.log(`Cleared ${_LOGGING.path}`);
  else if (outside.length === 0)
    console.log(`No log to clear at ${_LOGGING.path}`);
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

function main() {
  if (process.argv.includes("--log")) {
    cleanDiagnosticLog();
    return;
  }
  const dev = process.argv.includes("--dev");

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
};
