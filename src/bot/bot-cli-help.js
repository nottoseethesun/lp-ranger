/**
 * @file src/bot/bot-cli-help.js
 * @description The headless bot's `--help` text, for `node src/bot.js`.
 * The options both entry points take come from src/lib/cli-help.js.
 */

"use strict";

const { log } = require("../lib/log");
const { commonHelp } = require("../lib/cli-help");

/**
 * Print the headless bot's help, then the caller exits.
 */
module.exports = function showHelp() {
  log.info(`
LP Ranger — Headless Bot (no dashboard)

Usage:
  node src/bot.js [options]
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
${commonHelp()}`);
};
