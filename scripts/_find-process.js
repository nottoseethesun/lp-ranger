/**
 * @file scripts/_find-process.js
 * @description Shared PID lookup helpers used by ops scripts that need
 *   to find the running LP Ranger process (e.g. stop.js, debug-attach.js).
 *   The leading underscore marks this as a non-user-facing helper.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * List PIDs listening on the given TCP port via `lsof`.
 * Returns an empty list if `lsof` is missing or nothing is listening.
 * @param {number} port
 * @returns {number[]}
 */
function findListenerPids(port) {
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out
      ? out
          .split("\n")
          .filter(Boolean)
          .map((s) => Number(s))
      : [];
  } catch {
    return [];
  }
}

/**
 * Get the full command line for a PID via `ps`.  Returns an empty string
 * if the PID is gone or `ps` is missing.  Asks for `args`, the POSIX name
 * for the column, which Linux and macOS both accept; `cmd` is Linux's
 * alone.
 * @param {number} pid
 * @returns {string}
 */
function psCmd(pid) {
  try {
    return execSync(`ps -p ${pid} -o args=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The working directory of `pid`, or null when it cannot be read.  Linux
 * shows it under /proc; elsewhere, macOS among them, `lsof` reports it.
 * @param {number} pid
 * @returns {string|null}
 */
function processCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // Not Linux, or not this user's to read: ask lsof instead.
  }
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line === undefined ? null : line.slice(1);
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is this install's LP Ranger server.
 *
 * A PID file outlives a server killed outright, which runs no code to
 * remove it, and the system may since have given its number to another
 * process — another project's `node server.js` included.  So the answer
 * needs two things: a command line naming `server.js`, and a working
 * directory that is this install's root, where the server and `npm stop`
 * both run.  When either cannot be read, the answer is "unknown", and
 * nothing may be signalled on the strength of it.
 *
 * @param {number} pid
 * @param {string} [root]  The install's root; the current directory.
 * @returns {"yes"|"no"|"unknown"}
 */
function serverProcessState(pid, root = process.cwd()) {
  const cmd = psCmd(pid);
  if (cmd === "") return "unknown";
  if (!/\bserver\.js\b/.test(cmd)) return "no";
  const cwd = processCwd(pid);
  if (cwd === null) return "unknown";
  return path.resolve(cwd) === fs.realpathSync(root) ? "yes" : "no";
}

/**
 * Sort PIDs into this install's server and those that cannot be told
 * apart from it, by `serverProcessState`. Any other process, another
 * program listening on the same port among them, is in neither list.
 *
 * @param {number[]} pids
 * @param {string} [root]  The install's root; the current directory.
 * @returns {{ours: number[], unknown: number[]}}
 */
function sortServerPids(pids, root = process.cwd()) {
  const ours = [];
  const unknown = [];
  for (const pid of pids) {
    const state = serverProcessState(pid, root);
    if (state === "yes") ours.push(pid);
    else if (state === "unknown") unknown.push(pid);
  }
  return { ours, unknown };
}

module.exports = {
  findListenerPids,
  psCmd,
  processCwd,
  serverProcessState,
  sortServerPids,
};
