/**
 * @file src/cli-help.js
 * @description Print --help text for server.js or bot.js, then caller exits.
 */

"use strict";

const { log } = require("./log");
const COMMON = `
Options:
  --verbose, -v   Show detailed per-cycle logs (fee details,
                  OOR poll diagnostics). Also: VERBOSE=1 in .env.
  --log-file [PATH]
                  Tee all console output to a file (ANSI escapes
                  stripped).  PATH is optional — defaults to
                  logs/lp-ranger.log (or the path set in
                  app-config/app-defaults-for-user-configurable/logging.json).  File is
                  opened in append mode; rotate externally if it
                  grows.  Operators can enable persistently by
                  setting "enabled": true in the JSON.
  --help, -h      Show this help message and exit.

Environment:
  Runtime flags and secrets are configured via the .env file.
  Bot tunables (slippage, poll interval, OOR threshold, daily cap, …)
  live in the dashboard's Bot Settings panel — not the .env file.

  PORT              Dashboard port (default: 5555)
  PRIVATE_KEY       Wallet private key (or import via dashboard / CLI)
  WALLET_PASSWORD   Auto-unlock encrypted wallet at startup (optional)
  DRY_RUN           Read-only mode, no transactions (default: false)
  RPC_URL           PulseChain RPC endpoint

  See .env.example for the complete list of runtime flags.`;

const MODES = {
  server: `
LP Ranger — Dashboard + Auto-Rebalancing Bot

Usage:
  node server.js [options]
  node server.js --headless     Prompt for wallet password on terminal
                                (no browser needed to unlock)
  npm start                     Start the dashboard server
  npm run bot                   Headless bot (no dashboard)
  npm run build-and-start       Build dashboard JS + start server
${COMMON}`,

  bot: `
LP Ranger — Headless Bot (no dashboard)

Usage:
  node bot.js [options]
  npm run bot

  Requires PRIVATE_KEY in .env, or an imported wallet (app-config/user-configurable/wallet.json).

Bot-only options:
  --start-with-price-lookups-unpaused
                  Start the headless bot with price lookups enabled
                  (default: paused — only fetches during moves to
                  conserve price-source quota).  Use this when you want
                  continuous P&L cache warming on a headless box.
                  See docs/architecture.md "Idle-Driven Price-Lookup
                  Pause" for the full rationale.
${COMMON}`,

  /*- `build-and-start` runs two things, so its help answers for itself
   *  and then hands off. It does NOT repeat the server's flag list: that
   *  list lives in one place, and a copy here would drift the first time
   *  a flag changed. The lines below are meant to be pasted. */
  "build-and-start": `
LP Ranger — Build the dashboard, then start the server

Usage:
  npm run build-and-start [-- options]

What it does, in order:
  1. npm run build     Rebuild the dashboard bundle, the generated
                       content and the cache-bust stamps.
  2. node server.js    Start the dashboard server and auto-start every
                       position saved as running.

  Options after \`--\` are passed to the server, not to the build.
  The build takes no options.

Help for what it runs:
  npm start -- --help            Server options (the ones you can pass here)
  npm run build                  The build itself; it has no options

Common forms:
  npm run build-and-start
  npm run build-and-start -- --verbose
  npm run build-and-start -- --headless
  npm run build-and-start -- --log-file /tmp/burn-in.log
  npm run build-and-start -- --help     Show this text and exit

  Every command in the project is listed in
  docs/npm-project-commands.md.
`,
};

module.exports = function showHelp(mode) {
  log.info(MODES[mode] || MODES.server);
};
