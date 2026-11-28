#!/usr/bin/env node
/**
 * @file scripts/delete-all-caches-and-logs.js
 * @description
 * Deletes all of LP Ranger's caches and logs, the way back from any
 * damaged file among them, slow as the rebuild is (the user's design,
 * 2026-11-27). Two commands run it:
 * - `npm run delete-all-caches-and-logs` runs it alone, and it starts
 *   nothing after: the way to clear them when you run the headless bot,
 *   which you then start again with `npm run bot` (the user's ruling,
 *   2026-11-28);
 * - `npm run build-and-start -- --delete-all-caches-and-logs` runs it
 *   before it builds, passing `--server-starts-after`, then builds and
 *   starts the server (scripts/build-and-start.js).
 *
 * The caches are what `npm run clear-blockchain-scan-cache` clears,
 * whose script owns that definition: every scan cache in
 * `app-data/scan-cache/`, and the figures LP Ranger worked out from the
 * blockchain for each position, in `app-data/position-records.json`. The
 * logs are the rebalance log, wherever LOG_FILE or app-runtime.json puts
 * it, deleted wherever that is, since a damaged rebalance log is what the
 * last of the log's steps, told when LP Ranger cannot read it, sends the
 * operator here to remove; and the diagnostic log and the error log, wherever logging.json
 * puts them, each deleted only inside the install folder, as
 * `npm run clean` deletes them (scripts/clean.js). The wallet, the keys,
 * the settings, the rest of the position records and today's rebalance
 * counts are kept.
 *
 * It says all that first, that the rebuild can take several hours, that
 * a running LP Ranger is stopped first, and whether the server starts
 * after, and asks for YES, in capitals; any other answer, or none, stops
 * nothing and deletes nothing.
 * Once it has YES, it stops each LP Ranger program running in this
 * install, the server first and then the headless bot, each once nothing
 * is under way (the user's design, 2026-11-27): the server as
 * `npm run gentle-stop` stops it (scripts/gentle-stop.js), the headless
 * bot by the signal it takes for that, SIGUSR2 (src/bot.js). It waits
 * for each to exit, however long a rebalance, compound or scan under way
 * takes, and deletes nothing until each has. A program is found by its
 * PID file (src/lib/pid-file.js), believed only while the PID is still
 * this install's program (scripts/_find-process.js); a process it cannot
 * tell apart from one is not signalled, and nothing is stopped or
 * deleted. A file it could not delete is named, and nothing starts.
 *
 * A process of its own, since it loads `.env` to find LOG_FILE and where
 * the server listens: loaded in build-and-start's process, `.env`'s
 * values would reach the server it starts as though the shell had set
 * them (src/lib/env-settings.js `setBeforeEnvFile`). It takes `--help`,
 * and from build-and-start `--server-starts-after`; anything else is
 * refused before anything is stopped or deleted (scripts/_script-args.js).
 * Its exit status: 0 once all is deleted, and for an answer other than
 * YES when run alone; `DECLINED_EXIT` for that answer to build-and-start,
 * which then stops with no error; 1 for any failure, on which
 * build-and-start stops with that status.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  clearScanCache,
  clearScanDerivedConfig,
} = require("./clear-blockchain-scan-cache");
const { LOG_FILES, insideInstall, rmLogFiles } = require("./clean");
const { DECLINED_EXIT, SERVER_STARTS_AFTER } = require("./_delete-all-flag");
const { readScriptArgs, answeredWithoutWork } = require("./_script-args");
const { serverProcessState, botProcessState } = require("./_find-process");
const {
  askToStop,
  waitForServerExit,
  runGentleStop,
} = require("./gentle-stop");
const { isAlive } = require("./stop");
const { loadEnvFile } = require("../src/lib/env-settings");
const { rebalanceLogSetting } = require("../src/lib/rebalance-log-setting");
const { scanCacheDir } = require("../src/lib/scan-cache-dir");
const {
  readPid,
  SERVER_PID_FILE,
  BOT_PID_FILE,
} = require("../src/lib/pid-file");
const { serverHost, serverPort } = require("../src/lib/server-address");
const { readShutdownTimings } = require("../src/lib/shutdown-timing");

const ROOT = path.resolve(__dirname, "..");

const HELP_TEXT = `
delete-all-caches-and-logs — delete every cache and log, starting nothing after

USAGE
  npm run delete-all-caches-and-logs            Delete all of LP Ranger's
                                                caches and logs, once you
                                                type YES. A running LP
                                                Ranger is stopped first:
                                                the server, then the
                                                headless bot, each once
                                                nothing is under way.
  npm run delete-all-caches-and-logs -- --help  Show this text.

It deletes every blockchain scan cache, the figures LP Ranger worked out
from the blockchain for each position, the rebalance log, and the
diagnostic and error logs. Your wallet, keys and settings are kept.

It starts nothing after, so it is the way to clear the caches and logs
when you run the headless bot: start it again with npm run bot. With the
server, npm run build-and-start -- --delete-all-caches-and-logs deletes
the same, then builds and starts the server.

LP Ranger rebuilds its caches from the blockchain as it runs, which can
take several hours. Anything else is refused before anything is stopped
or deleted.
`.trim();

/*- How the operator starts LP Ranger again, when nothing starts after. */
const _START_AGAIN =
  "start LP Ranger again with npm run bot for the headless bot, or " +
  "npm run build-and-start for the server";

/** Wait `ms`. */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Which LP Ranger programs run in this install: the server and the
 * headless bot, each found by its PID file and believed only while that
 * PID is still this install's program. A process that cannot be told
 * apart from one, as when `ps` cannot be read, is named in `unknown`.
 * @param {string} root  The install folder.
 * @returns {{server: (number|null), bot: (number|null), unknown: string[]}}
 */
function runningPrograms(root) {
  const found = { server: null, bot: null, unknown: [] };
  for (const [name, file, isOurs] of [
    ["server", SERVER_PID_FILE, serverProcessState],
    ["bot", BOT_PID_FILE, botProcessState],
  ]) {
    const pid = readPid({ filePath: path.join(root, file) });
    if (pid === null || !isAlive(pid)) continue;
    const state = isOurs(pid, root);
    if (state === "yes") found[name] = pid;
    else if (state === "unknown") found.unknown.push(`PID ${pid} (${file})`);
  }
  return found;
}

/**
 * Stop the server once nothing is under way, as `npm run gentle-stop`
 * does, saying what the stop waits for, and wait for its process to exit.
 * @param {number} pid  The server's.
 * @returns {Promise<boolean>}  Whether it has exited.
 */
async function stopServerGently(pid) {
  const { gentleStopPollMs, checkIntervalMs } = readShutdownTimings();
  const host = serverHost();
  const port = serverPort();
  await runGentleStop({
    stop: () => askToStop({ host, port, timeoutMs: gentleStopPollMs }),
    waitForExit: () =>
      waitForServerExit({
        isRunning: () => isAlive(pid),
        sleep: _sleep,
        intervalMs: checkIntervalMs,
      }),
    sleep: _sleep,
    now: Date.now,
    pollMs: gentleStopPollMs,
    address: `${host}:${port}`,
  });
  return !isAlive(pid);
}

/**
 * Stop the headless bot once nothing is under way, by the signal it takes
 * for that (SIGUSR2, src/bot.js), and wait for its process to exit,
 * saying so each minute it has not.
 * @param {number} pid  The bot's.
 * @param {(line: string) => void} say
 * @returns {Promise<boolean>}  Whether it has exited.
 */
async function stopBotGently(pid, say) {
  const { checkIntervalMs } = readShutdownTimings();
  try {
    process.kill(pid, "SIGUSR2");
  } catch {
    return false;
  }
  const askedAt = Date.now();
  let minutesSaid = 0;
  while (isAlive(pid)) {
    await _sleep(checkIntervalMs);
    const minutes = Math.floor((Date.now() - askedAt) / 60_000);
    if (minutes > minutesSaid) {
      minutesSaid = minutes;
      say(
        `[delete-all] Still waiting for the headless bot to finish what it ` +
          `has under way (${minutes} min so far; its log says what)`,
      );
    }
  }
  return true;
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
 * The programs that run, in words: "the server (PID 1)", and so on.
 * @param {{server: (number|null), bot: (number|null)}} running
 * @returns {string[]}
 */
function _runningNames(running) {
  const names = [];
  if (running.server !== null) names.push(`the server (PID ${running.server})`);
  if (running.bot !== null) names.push(`the headless bot (PID ${running.bot})`);
  return names;
}

/**
 * What follows the deletion, for the warning. Run by build-and-start, the
 * server starts, in place of the headless bot when that is what runs, so
 * the warning names the command that starts nothing after; run alone,
 * nothing starts, and it says how to start LP Ranger again.
 * @param {{bot: (number|null)}} running  What runs as it asks.
 * @param {boolean} serverStartsAfter
 * @returns {string[]}
 */
function _afterwards(running, serverStartsAfter) {
  if (!serverStartsAfter)
    return [
      `Nothing starts after it: ${_START_AGAIN}. LP Ranger then rebuilds its caches from the blockchain as it runs, which can take it several hours.`,
    ];
  const lines = [
    "Then the server starts, and rebuilds LP Ranger's caches from the blockchain as it runs, which can take it several hours.",
  ];
  if (running.bot !== null)
    lines.push(
      "The server starts in place of the headless bot. To start the headless bot again instead, type anything but YES, then run npm run delete-all-caches-and-logs, which starts nothing after.",
    );
  return lines;
}

/**
 * The words that end a run: run by build-and-start, which starts the
 * server after, or alone, which starts nothing.
 * @param {boolean} serverStartsAfter
 * @returns {{didNotStart: string, leftOver: string, done: string}}
 */
function _endWords(serverStartsAfter) {
  if (serverStartsAfter)
    return {
      didNotStart: ", and LP Ranger did not start",
      leftOver:
        "then run npm run build-and-start again. LP Ranger did not start.",
      done: "LP Ranger starts now, and rebuilds its caches from the blockchain as it runs.",
    };
  return {
    didNotStart: "",
    leftOver: `then ${_START_AGAIN}.`,
    done: `Nothing was started: ${_START_AGAIN}. It rebuilds its caches from the blockchain as it runs.`,
  };
}

/**
 * The warning shown before the question: what goes, what stays, that a
 * running LP Ranger is stopped first, what follows, and how long the
 * rebuild can take.
 * @param {string[]} deleted  The log files it deletes, the rebalance log
 *   first.
 * @param {string[]} outside  The log files it leaves, being outside the
 *   install folder.
 * @param {string} cacheDir  The scan-cache folder, as shown.
 * @param {{server: (number|null), bot: (number|null)}} running  What runs
 *   as it asks.
 * @param {boolean} serverStartsAfter  Whether build-and-start runs it.
 * @returns {string}
 */
function _warning(deleted, outside, cacheDir, running, serverStartsAfter) {
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
    "If LP Ranger is running, it is stopped first, the server and then the headless bot, each once nothing is under way: a rebalance, compound or scan under way finishes first. Nothing is deleted until each has stopped.",
  );
  const names = _runningNames(running);
  if (names.length > 0) lines.push(`Running now: ${names.join(" and ")}.`);
  lines.push(..._afterwards(running, serverStartsAfter), "");
  return lines.join("\n");
}

/**
 * Say that a process cannot be told apart from LP Ranger, so nothing is
 * stopped or deleted.
 * @param {string[]} unknown  Each such process, by PID and PID file.
 * @param {(line: string) => void} say
 * @returns {"refused"}
 */
function _cannotTell(unknown, say) {
  say(
    `[delete-all] Cannot tell whether ${unknown.join(" or ")} is LP ` +
      "Ranger: `ps` or its working folder cannot be read. Stop LP Ranger " +
      "yourself, then try again. Nothing was stopped or deleted.",
  );
  return "refused";
}

/**
 * Stop each program that runs, the server first and then the headless
 * bot, each once nothing is under way, waiting for it to exit.
 * @param {{server: (number|null), bot: (number|null)}} running
 * @param {(line: string) => void} say
 * @param {(pid: number, say: Function) => Promise<boolean>} stopServer
 * @param {(pid: number, say: Function) => Promise<boolean>} stopBot
 * @param {string} didNotStart  What a failure adds about the start that
 *   follows: ", and LP Ranger did not start" from build-and-start, else
 *   nothing.
 * @returns {Promise<boolean>}  Whether each has exited.
 */
async function _stopEach(running, say, stopServer, stopBot, didNotStart) {
  for (const [pid, name, stop] of [
    [running.server, "the LP Ranger server", stopServer],
    [running.bot, "the headless bot", stopBot],
  ]) {
    if (pid === null) continue;
    say(
      `[delete-all] Stopping ${name} (PID ${pid}) once nothing is under way...`,
    );
    if (await stop(pid, say)) continue;
    say(
      `[delete-all] Could not stop ${name} (PID ${pid}). Nothing was ` +
        `deleted${didNotStart}.`,
    );
    return false;
  }
  return true;
}

/**
 * Delete all of LP Ranger's caches and logs, once the operator has typed
 * YES and each LP Ranger program that runs has stopped.
 * @param {object} o
 * @param {(question: string) => Promise<string>} o.ask  Asks the
 *   operator, answering what they typed.
 * @param {string} o.rebalanceLog  The rebalance log, deleted wherever it
 *   is; relative to `root` unless absolute, as are `logs`.
 * @param {string[]} o.logs  The diagnostic log and the error log, each
 *   deleted only inside the install folder.
 * @param {(line: string) => void} [o.say]  Tells the operator.
 * @param {(root: string) => {server: (number|null), bot: (number|null),
 *   unknown: string[]}} [o.running]  Which programs run in the install.
 * @param {(pid: number, say: Function) => Promise<boolean>} [o.stopServer]
 *   Stops the server once nothing is under way; true once it has exited.
 * @param {(pid: number, say: Function) => Promise<boolean>} [o.stopBot]
 *   Stops the headless bot the same way.
 * @param {string} [o.root]  The install folder; this one unless a test
 *   points elsewhere.
 * @param {string} [o.configDir]  The settings folder whose position
 *   records lose their figures; the install's unless a test passes one.
 * @param {boolean} [o.serverStartsAfter]  True when build-and-start runs
 *   it, and starts the server after; run alone, nothing starts after.
 * @returns {Promise<"deleted"|"declined"|"refused"|"failed">}
 */
async function deleteAllCachesAndLogs({
  ask,
  rebalanceLog,
  logs,
  say = console.log,
  running = runningPrograms,
  stopServer = stopServerGently,
  stopBot = stopBotGently,
  root = ROOT,
  configDir,
  serverStartsAfter = false,
}) {
  const before = running(root);
  if (before.unknown.length > 0) return _cannotTell(before.unknown, say);
  const inside = logs.filter((f) => insideInstall(f, root));
  const outside = logs.filter((f) => !insideInstall(f, root));
  const deleted = [rebalanceLog, ...inside];
  const shown = (f) => _shown(f, root);
  const cacheDir = shown(scanCacheDir());
  const end = _endWords(serverStartsAfter);
  say(
    _warning(deleted.map(shown), outside, cacheDir, before, serverStartsAfter),
  );
  const answer = await ask(
    "Type YES to go ahead, or anything else to cancel: ",
  );
  if (answer.trim() !== "YES") {
    say("[delete-all] Cancelled: nothing was stopped or deleted.");
    return "declined";
  }
  // Asked again: a program may have started or stopped while it waited.
  const now = running(root);
  if (now.unknown.length > 0) return _cannotTell(now.unknown, say);
  if (!(await _stopEach(now, say, stopServer, stopBot, end.didNotStart)))
    return "failed";
  const cache = clearScanCache();
  clearScanDerivedConfig({ dir: configDir });
  _unlinkIfThere(path.resolve(root, rebalanceLog));
  rmLogFiles(inside, root);
  const left = deleted
    .filter((f) => fs.existsSync(path.resolve(root, f)))
    .map(shown);
  const cacheLeft = cache.files.length - cache.removed;
  if (cacheLeft > 0)
    left.push(`${cacheLeft} scan cache file(s) in ${cacheDir}`);
  if (left.length > 0) {
    say(
      `[delete-all] Could not delete: ${left.join("; ")}. Delete what is ` +
        `left yourself, ${end.leftOver}`,
    );
    return "failed";
  }
  say(`[delete-all] Deleted all of LP Ranger's caches and logs. ${end.done}`);
  return "deleted";
}

/**
 * The exit status for how a run ended: 0 once all is deleted; for an
 * answer other than YES, `DECLINED_EXIT` to build-and-start, which then
 * stops with no error, and 0 when run alone, nothing having gone wrong;
 * 1 for any failure.
 * @param {"deleted"|"declined"|"refused"|"failed"} outcome
 * @param {boolean} serverStartsAfter  Whether build-and-start runs it.
 * @returns {number}
 */
function _exitStatus(outcome, serverStartsAfter) {
  if (outcome === "deleted") return 0;
  if (outcome === "declined") return serverStartsAfter ? DECLINED_EXIT : 0;
  return 1;
}

/** Run it for this install, and give its caller its exit status. */
async function main() {
  const args = readScriptArgs(process.argv.slice(2), [SERVER_STARTS_AFTER]);
  const text = {
    tag: "delete-all",
    help: HELP_TEXT,
    nothing: "Nothing was stopped or deleted.",
  };
  if (answeredWithoutWork(args, text)) return;
  const serverStartsAfter = args.flags.has(SERVER_STARTS_AFTER);
  loadEnvFile();
  const outcome = await deleteAllCachesAndLogs({
    ask: askTerminal,
    rebalanceLog: rebalanceLogSetting(),
    logs: LOG_FILES,
    serverStartsAfter,
  });
  process.exitCode = _exitStatus(outcome, serverStartsAfter);
}

if (require.main === module) main();

module.exports = {
  deleteAllCachesAndLogs,
  runningPrograms,
  stopBotGently,
  _exitStatus, // exported for tests
};
