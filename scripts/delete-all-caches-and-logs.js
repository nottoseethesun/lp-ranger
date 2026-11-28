#!/usr/bin/env node
/**
 * @file scripts/delete-all-caches-and-logs.js
 * @description
 * What `npm run build-and-start -- --delete-all-caches-and-logs` runs
 * before it builds: it deletes all of LP Ranger's caches and logs, the
 * way back from any damaged file among them, slow as the rebuild is (the
 * user's design, 2026-11-27).
 *
 * The caches are what `npm run clear-blockchain-scan-cache` clears,
 * whose script owns that definition: every scan cache in
 * `app-data/scan-cache/`, and the figures LP Ranger worked out from the
 * blockchain for each position, in `app-data/position-records.json`. The
 * logs are the rebalance log, wherever LOG_FILE or app-runtime.json puts
 * it, deleted wherever that is, since a damaged rebalance log is what the
 * Rebalance log error dialog's last step sends the operator here to
 * remove; and the diagnostic log and the error log, wherever logging.json
 * puts them, each deleted only inside the install folder, as
 * `npm run clean` deletes them (scripts/clean.js). The wallet, the keys,
 * the settings, the rest of the position records and today's rebalance
 * counts are kept.
 *
 * It says all that first, and that the rebuild can take several hours,
 * and asks for YES, in capitals; any other answer, or none, deletes
 * nothing. Refused while LP Ranger runs. A file it could not delete is
 * named, and LP Ranger does not start.
 *
 * A process of its own, run by scripts/build-and-start.js, since it
 * loads `.env` to find LOG_FILE: loaded in build-and-start's process,
 * `.env`'s values would reach the server it starts as though the shell
 * had set them (src/lib/env-settings.js `setBeforeEnvFile`). It takes no
 * arguments. Its exit status tells build-and-start what to do: 0 to
 * build and start, `DECLINED_EXIT` to stop with no error, anything else
 * to stop with that status.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  clearScanCache,
  clearScanDerivedConfig,
  runningPid,
} = require("./clear-blockchain-scan-cache");
const { LOG_FILES, insideInstall, rmLogFiles } = require("./clean");
const { DECLINED_EXIT } = require("./_delete-all-flag");
const { loadEnvFile } = require("../src/lib/env-settings");
const { rebalanceLogSetting } = require("../src/lib/rebalance-log-setting");
const { scanCacheDir } = require("../src/lib/scan-cache-dir");

const ROOT = path.resolve(__dirname, "..");

/**
 * Ask `question` on the terminal, and answer what was typed, or "" when
 * the input ends first, as with no terminal to type into.
 * @param {string} question
 * @returns {Promise<string>}
 */
function askTerminal(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

/**
 * Delete a file, if it is there. One it could not delete is found by the
 * check after every deletion, which names it.
 * @param {string} abs
 */
function _unlinkIfThere(abs) {
  try {
    fs.unlinkSync(abs);
  } catch {
    // Gone already, or named by the check that follows.
  }
}

/**
 * A path as the operator reads it: relative to the install folder when
 * inside it.
 * @param {string} p
 * @param {string} root
 * @returns {string}
 */
function _shown(p, root) {
  return insideInstall(p, root)
    ? path.relative(root, path.resolve(root, p))
    : p;
}

/**
 * The warning shown before the question: what goes, what stays, and how
 * long the rebuild can take.
 * @param {string[]} deleted  The log files it deletes, the rebalance log
 *   first.
 * @param {string[]} outside  The log files it leaves, being outside the
 *   install folder.
 * @param {string} cacheDir  The scan-cache folder, as shown.
 * @returns {string}
 */
function _warning(deleted, outside, cacheDir) {
  const lines = [
    "",
    "This deletes ALL of LP Ranger's caches and logs:",
    `  - every blockchain scan cache, in ${cacheDir}, and the figures LP Ranger worked out from the blockchain for each position;`,
    `  - the logs: ${deleted.join(", ")}.`,
  ];
  if (outside.length > 0)
    lines.push(
      `Left alone, being outside the install folder: ${outside.join(", ")}.`,
    );
  lines.push(
    "Your wallet, keys and settings are kept.",
    "LP Ranger then rebuilds its caches from the blockchain as it runs, which can take it several hours.",
    "",
  );
  return lines.join("\n");
}

/**
 * Delete all of LP Ranger's caches and logs, once the operator has typed
 * YES.
 * @param {object} o
 * @param {(question: string) => Promise<string>} o.ask  Asks the
 *   operator, answering what they typed.
 * @param {string} o.rebalanceLog  The rebalance log, deleted wherever it
 *   is; relative to `root` unless absolute, as are `logs`.
 * @param {string[]} o.logs  The diagnostic log and the error log, each
 *   deleted only inside the install folder.
 * @param {(line: string) => void} [o.say]  Tells the operator.
 * @param {() => (number|null)} [o.serverPid]  A running server's PID, or
 *   null.
 * @param {string} [o.root]  The install folder; this one unless a test
 *   points elsewhere.
 * @param {string} [o.configDir]  The settings folder whose position
 *   records lose their figures; the install's unless a test passes one.
 * @returns {Promise<"deleted"|"declined"|"refused"|"failed">}
 */
async function deleteAllCachesAndLogs({
  ask,
  rebalanceLog,
  logs,
  say = console.log,
  serverPid = runningPid,
  root = ROOT,
  configDir,
}) {
  const pid = serverPid();
  if (pid !== null) {
    say(
      `[delete-all] LP Ranger is running (PID ${pid}). Stop it first with ` +
        "npm run gentle-stop, then try again. Nothing was deleted.",
    );
    return "refused";
  }
  const inside = logs.filter((f) => insideInstall(f, root));
  const outside = logs.filter((f) => !insideInstall(f, root));
  const deleted = [rebalanceLog, ...inside];
  const cacheDir = _shown(scanCacheDir(), root);
  say(_warning(deleted, outside, cacheDir));
  const answer = await ask(
    "Type YES to delete them and start LP Ranger, or anything else to stop: ",
  );
  if (answer.trim() !== "YES") {
    say("[delete-all] Nothing was deleted, and LP Ranger did not start.");
    return "declined";
  }
  const cache = clearScanCache();
  clearScanDerivedConfig({ dir: configDir });
  _unlinkIfThere(path.resolve(root, rebalanceLog));
  rmLogFiles(inside, root);
  const left = deleted.filter((f) => fs.existsSync(path.resolve(root, f)));
  const cacheLeft = cache.files.length - cache.removed;
  if (cacheLeft > 0)
    left.push(`${cacheLeft} scan cache file(s) in ${cacheDir}`);
  if (left.length > 0) {
    say(
      `[delete-all] Could not delete: ${left.join("; ")}. Delete what is ` +
        "left yourself, then run npm run build-and-start again. LP Ranger " +
        "did not start.",
    );
    return "failed";
  }
  say(
    "[delete-all] Deleted all of LP Ranger's caches and logs. LP Ranger " +
      "starts now, and rebuilds its caches from the blockchain as it runs.",
  );
  return "deleted";
}

/** Run it for this install, and give build-and-start its exit status. */
async function main() {
  loadEnvFile();
  const outcome = await deleteAllCachesAndLogs({
    ask: askTerminal,
    rebalanceLog: rebalanceLogSetting(),
    logs: LOG_FILES,
  });
  if (outcome === "deleted") return;
  process.exitCode = outcome === "declined" ? DECLINED_EXIT : 1;
}

if (require.main === module) main();

module.exports = { deleteAllCachesAndLogs };
