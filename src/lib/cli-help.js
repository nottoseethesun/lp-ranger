/**
 * @file src/lib/cli-help.js
 * @description The part of the `--help` text the server and the headless
 * bot share: the options and environment both entry points take. Each
 * entry point prints its own usage with this appended: the server's in
 * src/server/server-cli-help.js, the bot's in src/bot/bot-cli-help.js.
 */

"use strict";

const { loadMergedDefaults } = require("./load-merged-defaults");

/**
 * The options and environment both entry points take. The defaults it
 * quotes are read from the files that set them, when the help is asked
 * for, so it states what this install will actually do.
 * @returns {string}
 */
function commonHelp() {
  const logPath = loadMergedDefaults("logging.json").path;
  const port = loadMergedDefaults("app-runtime.json").server.port;
  return `
Options:
  --verbose, -v   Show detailed per-cycle logs (fee details,
                  OOR poll diagnostics). Also: VERBOSE=true in .env.
  --log-file [PATH]
                  Tee all console output to a file (ANSI escapes
                  stripped).  PATH is optional — defaults to the
                  path set in logging.json, here ${logPath}.  File is
                  opened in append mode; rotate externally if it
                  grows.  Operators can enable persistently by
                  setting "enabled": true in the JSON.
  --delete-pre-existing-log-file
                  Delete the log file before this run starts writing,
                  so it holds this run and nothing else.  Needs
                  log-to-file to be on (via --log-file or the JSON);
                  on its own it does nothing.  Note that under
                  "npm run dev" the server restarts on every file
                  change, and each restart clears the log again.
  --help, -h      Show this help message and exit.

Environment:
  Runtime flags and secrets are configured via the .env file.
  Bot tunables (slippage, poll interval, OOR threshold, daily cap, …)
  live in the dashboard's Bot Settings panel — not the .env file.

  PORT              Dashboard port (default: ${port})
  PRIVATE_KEY       Wallet private key (or import via dashboard / CLI)
  WALLET_PASSWORD   Auto-unlock encrypted wallet at startup (optional)
  DRY_RUN           Read-only mode, no transactions (default: false)
  RPC_URL           First RPC endpoint for the active chain

  See .env.example for the complete list of runtime flags.`;
}

module.exports = { commonHelp };
