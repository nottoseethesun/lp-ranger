/**
 * @file src/server/server-cli-help.js
 * @description The server's `--help` text: `node src/server.js` and
 * `npm run build-and-start`, which builds the dashboard and starts the
 * server. The options both entry points take come from src/lib/cli-help.js.
 */

"use strict";

const { log } = require("../lib/log");
const { commonHelp } = require("../lib/cli-help");

/**
 * The server's usage, with the shared options appended.
 * @returns {string}
 */
function _serverHelp() {
  return `
LP Ranger — Dashboard + Auto-Rebalancing Bot

Usage:
  node src/server.js [options]
  node src/server.js --unlock-at-terminal
                                Ask for the wallet password at this
                                terminal as the server starts; the
                                dashboard is still served, and can
                                unlock the wallet meanwhile. With no
                                password from either, the server exits
  npm start                     Start the dashboard server
  npm run bot                   Headless bot (no dashboard)
  npm run build-and-start       Build dashboard JS + start server
${commonHelp()}`;
}

/*- `build-and-start` runs two things, so its help answers for itself
 *  and then hands off. It does NOT repeat the server's flag list: that
 *  list lives in one place, and a copy here would drift the first time
 *  a flag changed. The lines below are meant to be pasted. */
const _BUILD_AND_START_HELP = `
LP Ranger — Build the dashboard, then start the server

Usage:
  npm run build-and-start [-- options]

What it does, in order:
  1. npm run build     Rebuild the dashboard bundle, the generated
                       content and the cache-bust stamps.
  2. node src/server.js
                       Start the dashboard server and auto-start every
                       position saved as running.

  Options after \`--\` are passed to the server, not to the build.
  The build takes no options. One option is build-and-start's own:

  --delete-all-caches-and-logs
                       Before the build, delete all of LP Ranger's
                       caches and logs: the way back from a damaged
                       one, such as an unreadable rebalance log. It
                       says what goes first, and that the rebuild from
                       the blockchain can take several hours, and asks
                       you to type YES; any other answer stops here,
                       deleting nothing. The wallet, keys and settings
                       are kept. Refused while LP Ranger runs.

Help for what it runs:
  npm start -- --help            Server options (the ones you can pass here)
  npm run build                  The build itself; it has no options

Common forms:
  npm run build-and-start
  npm run build-and-start -- --verbose
  npm run build-and-start -- --unlock-at-terminal
  npm run build-and-start -- --log-file /tmp/burn-in.log
  npm run build-and-start -- --log-file --delete-pre-existing-log-file
                                        Fresh log holding this run only
  npm run build-and-start -- --delete-all-caches-and-logs
                                        Start over with no caches or logs
  npm run build-and-start -- --help     Show this text and exit

  Every command in the project is listed in
  docs/npm-project-commands.md.
`;

/**
 * Print the help for `mode`, then the caller exits.
 * @param {string} [mode]  "build-and-start", or anything else for the
 *   server's own help.
 */
module.exports = function showHelp(mode) {
  log.info(mode === "build-and-start" ? _BUILD_AND_START_HELP : _serverHelp());
};
