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
const { serverPort } = require("../src/server-address");

attach({
  entry: "server",
  // Read as `npm stop` reads it: PORT in `.env`, else app-runtime.json.
  port: serverPort(),
  label: "server",
});
