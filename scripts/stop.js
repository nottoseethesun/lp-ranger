/**
 * @file scripts/stop.js
 * @description Gracefully stop the LP Ranger server (`npm stop`).
 *
 *   Primary: read the PID from `tmp/lp-ranger.pid` (written on startup by
 *   `src/server-pid.js`) and send SIGTERM — the same clean shutdown as Ctrl+C
 *   (stops all positions, closes the HTTP server, removes the PID file). If
 *   the process is still alive once the server's own exit timeout has
 *   passed, plus a margin, escalate to SIGKILL and clear the now-stale PID
 *   file. Both waits come from the `shutdown` group of app-runtime.json,
 *   read through `src/shutdown-timing.js`, which keeps the kill the later
 *   of the two.
 *
 *   Fallback: when there is no PID file (the server was started by an older
 *   build), or the file names a process that is not this install's server
 *   (it was killed outright, which leaves the file behind), locate the
 *   `node server.js` listener on the port via lsof and signal it. The port
 *   is resolved as the server resolves it, from `.env` or app-runtime.json.
 *
 *   When it cannot be told whether the PID is the server — `ps` or the
 *   process's working directory cannot be read — nothing is signalled and
 *   the file is left in place.
 */

"use strict";

const { log } = require("../src/log");
const { readPid, getPidFilePath, removePidFile } = require("../src/server-pid");
const { PORT } = require("../src/runtime-flags");
const { readShutdownTimings } = require("../src/shutdown-timing");
const {
  findListenerPids,
  psCmd,
  serverProcessState,
} = require("./_find-process");

const { killAfterMs, checkIntervalMs } = readShutdownTimings();

/** Short sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a signal to a PID; swallow errors. Returns true if delivered. */
function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** True when the process is alive (signal 0 is an existence/permission probe). */
function isAlive(pid) {
  return signalPid(pid, 0);
}

/**
 * Wait until `gone()` answers true or `killAfterMs` has passed, checking
 * every `checkIntervalMs`.
 * @param {function(): boolean} gone
 * @returns {Promise<boolean>} Whether it went in time.
 */
async function waitUntilGone(gone) {
  const deadline = Date.now() + killAfterMs;
  while (!gone()) {
    if (Date.now() >= deadline) return false;
    await sleep(checkIntervalMs);
  }
  return true;
}

/** Stop by PID: SIGTERM, then SIGKILL if it outlasts the server's own exit timeout. */
async function stopByPid(pid) {
  const state = isAlive(pid) ? serverProcessState(pid) : "no";
  if (state === "unknown") {
    log.warn(
      "Cannot tell whether PID %d (from %s) is this LP Ranger server -- `ps` " +
        "or its working directory cannot be read. Not signalling it; stop the " +
        "server with Ctrl+C in its terminal.",
      pid,
      getPidFilePath(),
    );
    process.exitCode = 1;
    return;
  }
  /*-
   *  A server that exits on its own removes the file; one killed
   *  outright cannot, and its number may since belong to another
   *  process. So the file is believed only while its PID is still this
   *  install's server, and otherwise cleared and the port asked instead.
   */
  if (state === "no") {
    log.info(
      "PID %d (from %s) is not the LP Ranger server -- clearing stale PID file",
      pid,
      getPidFilePath(),
    );
    removePidFile();
    await stopByPort();
    return;
  }
  log.info("Sending SIGTERM to PID %d -- graceful shutdown...", pid);
  signalPid(pid, "SIGTERM");
  if (!(await waitUntilGone(() => !isAlive(pid)))) {
    log.info("⚠ Still running after SIGTERM -- sending SIGKILL");
    signalPid(pid, "SIGKILL");
    removePidFile();
  }
  log.info("✔ Stopped");
}

/** Fallback: find the node listener on PORT and signal it. */
async function stopByPort() {
  const pids = findListenerPids(PORT).filter((pid) => /node/.test(psCmd(pid)));
  if (pids.length === 0) {
    log.info(
      "No PID file and nothing listening on port %d -- server not running",
      PORT,
    );
    return;
  }
  for (const pid of pids) {
    log.info("Sending SIGTERM to PID %d (port %d)...", pid, PORT);
    signalPid(pid, "SIGTERM");
  }
  if (!(await waitUntilGone(() => findListenerPids(PORT).length === 0))) {
    log.info("⚠ Still running -- sending SIGKILL");
    for (const pid of findListenerPids(PORT)) signalPid(pid, "SIGKILL");
  }
  log.info("✔ Stopped");
}

(async function main() {
  log.info("Stopping LP Ranger server...");
  const pid = readPid();
  if (pid !== null) {
    await stopByPid(pid);
    return;
  }
  await stopByPort();
})();
