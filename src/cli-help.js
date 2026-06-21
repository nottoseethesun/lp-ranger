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
                  app-config/lp-ranger.log (or the path set in
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
9mm v3 Position Manager — Dashboard + Auto-Rebalancing Bot

Usage:
  node server.js [options]
  node server.js --headless     Prompt for wallet password on terminal
                                (no browser needed to unlock)
  npm start                     Start the dashboard server
  npm run bot                   Headless bot (no dashboard)
  npm run build-and-start       Build dashboard JS + start server
${COMMON}`,

  bot: `
9mm v3 Position Manager — Headless Bot (no dashboard)

Usage:
  node bot.js [options]
  npm run bot

  Requires PRIVATE_KEY in .env, or an imported wallet (.wallet.json).

Bot-only options:
  --start-with-price-lookups-unpaused
                  Start the headless bot with price lookups enabled
                  (default: paused — only fetches during moves to
                  conserve price-source quota).  Use this when you want
                  continuous P&L cache warming on a headless box.
                  See docs/architecture.md "Idle-Driven Price-Lookup
                  Pause" for the full rationale.
${COMMON}`,
};

module.exports = function showHelp(mode) {
  log.info(MODES[mode] || MODES.server);
};
