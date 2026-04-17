/**
 * @file src/server-shutdown.js
 * @description
 * Fire-and-forget Telegram notification for server/bot shutdown.  Extracted
 * from server.js to keep that file within the max-lines budget.
 *
 * Spawns a detached child process (scripts/telegram-send.js) so the message
 * survives the parent's process.exit().  Gated on the `shutdown` event being
 * enabled in the user's Telegram notification preferences.
 */

"use strict";

const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const telegram = require("./telegram");

/** Path to the detached sender script, resolved from project root. */
const _SEND_SCRIPT = path.join(__dirname, "..", "scripts", "telegram-send.js");

/**
 * Send a Telegram shutdown notification if configured and enabled.
 * Returns quickly; the actual send happens in a detached child.
 */
function notifyShutdown() {
  if (!telegram.isConfigured()) return;
  if (!telegram.getEnabledEvents().shutdown) {
    console.log("[server] Shutdown Telegram notification disabled — skipping");
    return;
  }
  console.log("[server] Sending shutdown notification via Telegram");
  const host = os.hostname();
  const msg =
    `*LP Ranger on ${host}*: The Server (includes the Bot) is shutting ` +
    `down: Manual restart may be required.`;
  const child = spawn(
    process.execPath,
    [_SEND_SCRIPT, telegram.getBotToken(), telegram.getChatId(), msg],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

module.exports = { notifyShutdown };
