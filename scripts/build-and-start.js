/**
 * @file scripts/build-and-start.js
 * @description
 * `npm run build-and-start` — rebuild the dashboard, then start the
 * server.
 *
 * **Why this is a script and not two commands chained in package.json.**
 * It was `npm run build && node server.js`. npm appends everything after
 * `--` to the END of that line, so `npm run build-and-start -- --help`
 * became `npm run build && node server.js --help`: the full build ran,
 * taking tens of seconds and rewriting the bundle and the cache-bust
 * stamps, and only then did the server print its help and exit. Asking
 * what a command does should not perform the command.
 *
 * A flag that must be seen BEFORE the first step therefore needs
 * something in front of both steps, which is this file.
 *
 * Signals and exit codes are the shell's old behaviour, kept: each step
 * runs with `stdio: "inherit"` so the terminal talks to it directly, a
 * failed build stops the run with its own exit code, and Ctrl+C or
 * `npm stop` reaches `server.js` itself — which owns the PID file and
 * the shutdown handler.
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const cliHelp = require("../src/cli-help");

const ROOT = path.join(__dirname, "..");

/*- Everything after the script name. npm has already stripped its own
 *  `--` separator, so these are the operator's flags. */
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  cliHelp("build-and-start");
  process.exit(0);
}

/*- Step one. `shell: true` on Windows only — npm is a shim there and
 *  cannot be exec'd directly; elsewhere it is an ordinary executable and
 *  a shell would only add a quoting hazard. */
const build = spawnSync("npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) process.exit(build.status === null ? 1 : build.status);

/*- Step two. Not `npm start`: that would run the `prestart` artifact
 *  check, which the build above has just satisfied, and would put a
 *  second npm process between the terminal and the server for no gain.
 *  The operator's flags go here, where the server reads them. */
const server = spawnSync(
  process.execPath,
  [path.join(ROOT, "server.js"), ...args],
  {
    cwd: ROOT,
    stdio: "inherit",
  },
);
process.exit(server.status === null ? 1 : server.status);
