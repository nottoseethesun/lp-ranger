/**
 * @file scripts/_run-async.js
 * @description Run a command to completion without blocking this
 *   process, for a script that has to notice a signal while the command
 *   runs. `spawnSync` blocks the event loop, so a signal listener cannot
 *   run until the command, and every synchronous step after it, is done:
 *   `npm run check` waits on its test runs this way, so a Ctrl+C during
 *   one is noticed before the next starts.
 *   The leading underscore marks this as a non-user-facing helper.
 */

"use strict";

const { spawn } = require("child_process");

/**
 * Run `cmd` with `args`, gather its output, and settle once it has
 * exited.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]  As for `child_process.spawn`; output is always
 *   piped, so it can be gathered.
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 *   `status` is 1 for a command that ended on a signal or could not
 *   start, as `run` in scripts/check.js answers.
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      resolve({ status: 1, stdout, stderr: stderr + err.message }),
    );
    child.on("close", (status) =>
      resolve({ status: status === null ? 1 : status, stdout, stderr }),
    );
  });
}

module.exports = { runAsync };
