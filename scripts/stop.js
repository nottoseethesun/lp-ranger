/**
 * @file scripts/stop.js
 * @description Gracefully stop the LP Ranger server.
 *   1. Try POST /api/shutdown with a 5-second timeout (CSRF-protected).
 *   2. If that fails, locate the `node server.js` process listening on
 *      the port via `lsof` and send SIGTERM.
 *   3. If still running a moment later, escalate to SIGKILL.
 */

"use strict";

const { log } = require("../src/log");
const { findListenerPids, psCmd } = require("./_find-process");

const PORT = Number(process.env.PORT || 5555);
const BASE = `http://127.0.0.1:${PORT}`;

/** Short sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch with AbortController-based timeout. Returns null on failure. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Try the graceful POST /api/shutdown path. Returns true on success. */
async function tryGracefulShutdown() {
  const csrfRes = await fetchWithTimeout(`${BASE}/api/csrf-token`);
  if (!csrfRes || !csrfRes.ok) return false;
  let token;
  try {
    ({ token } = await csrfRes.json());
  } catch {
    return false;
  }
  if (!token) return false;

  const res = await fetchWithTimeout(`${BASE}/api/shutdown`, {
    method: "POST",
    headers: { "x-csrf-token": token },
  });
  return !!res && res.ok;
}

/** Send a signal to a PID, swallow errors. */
function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

(async function main() {
  log.info("Stopping 9mm Position Manager on port %d...", PORT);

  if (await tryGracefulShutdown()) {
    log.info("✔ Graceful shutdown succeeded");
    return;
  }

  log.info(
    "Graceful shutdown failed — looking for process on port %d...",
    PORT,
  );

  const pids = findListenerPids(PORT);
  if (pids.length === 0) {
    log.info("No process found listening on port %d", PORT);
    return;
  }

  for (const pid of pids) {
    const cmd = psCmd(pid);
    if (/node/.test(cmd)) {
      if (signalPid(pid, "SIGTERM")) {
        log.info("✔ Killed PID %d (%s)", pid, cmd);
      }
    }
  }

  // Brief wait, then SIGKILL anything still listening.
  await sleep(1000);
  const remaining = findListenerPids(PORT);
  if (remaining.length > 0) {
    log.info("⚠ Process still running — sending SIGKILL");
    for (const pid of remaining) signalPid(pid, "SIGKILL");
  }

  log.info("✔ Stopped");
})();
