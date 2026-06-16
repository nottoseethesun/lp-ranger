/**
 * @file scripts/_find-process.js
 * @description Shared PID lookup helpers used by ops scripts that need
 *   to find the running LP Ranger process (e.g. stop.js, debug-attach.js).
 *   The leading underscore marks this as a non-user-facing helper.
 */

"use strict";

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
 * if the PID is gone or `ps` is missing.
 * @param {number} pid
 * @returns {string}
 */
function psCmd(pid) {
  try {
    return execSync(`ps -p ${pid} -o cmd=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

module.exports = { findListenerPids, psCmd };
