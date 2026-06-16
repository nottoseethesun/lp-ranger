/**
 * @file scripts/debug-attach-bot.js
 * @description Attach the Node V8 inspector to the running headless
 *   `bot.js` process.  Sends `SIGUSR1` so the inspector starts without
 *   restarting the bot — useful when the bot is in a stuck-syncing
 *   state and a restart would lose the wedge.
 *
 *   `bot.js` doesn't bind a port, so PID discovery is `pgrep`-only.
 *
 *   Companion to `npm run debug-attach` (which targets the dashboard
 *   server).  Mirrors the `npm run debug` / `npm run debug-bot` pair.
 */

"use strict";

const { attach } = require("./_debug-attach");

attach({
  entry: "bot",
  port: null,
  label: "bot",
});
