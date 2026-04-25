/**
 * @file src/cli-help.js
 * @description Print --help text for server.js or bot.js, then caller exits.
 */

"use strict";

const COMMON = `
Options:
  --verbose, -v   Show detailed per-cycle logs (fee details,
                  OOR poll diagnostics). Also: VERBOSE=1 in .env.
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
${COMMON}`,
};

module.exports = function showHelp(mode) {
  console.log(MODES[mode] || MODES.server);
};
