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

Stopping:
  kill -USR2 "$(cat tmp/lp-ranger-bot.pid)"
                  Stop once nothing is under way: nothing new starts,
                  and it exits once each rebalance, compound and scan
                  under way has finished.  The headless bot writes its
                  PID to tmp/lp-ranger-bot.pid as it starts.
  Ctrl+C          Force-stop: exits within three seconds, cutting off
                  a rebalance or compound under way.  SIGTERM does the
                  same.

Deleting every cache and log:
  npm run delete-all-caches-and-logs
                  Once you type YES, stops the headless bot once
                  nothing is under way, deletes all of LP Ranger's
                  caches and logs, and starts nothing after: start the
                  headless bot again with npm run bot.  The wallet,
                  keys and settings are kept.
${commonHelp()}`);
};
