/**
 * @file scripts/debug-attach.js
 * @description Attach the Node V8 inspector to the running `server.js`
 *   process (the full dashboard + auto-started bot).  Sends `SIGUSR1`
 *   so the inspector starts without restarting the app — any wedged
 *   state or in-flight rebalance is preserved for inspection.
 *
 *   Companion to `npm run debug-attach-bot` (which targets headless
 *   `bot.js`).  Mirrors the `npm run debug` / `npm run debug-bot` pair.
 */

"use strict";

const { attach } = require("./_debug-attach");

attach({
  entry: "server",
  port: Number(process.env.PORT || 5555),
  label: "server",
});
