/**
 * @file src/telegram-notifications/server-shutdown.js
 * @description
 * Fire-and-forget Telegram notification for server/bot shutdown.  Extracted
 * from server.js to keep that file within the max-lines budget.
 *
 * Spawns a detached child process (scripts/telegram-send.js) so the message
 * survives the parent's process.exit().  Gated on the `shutdown` event being
 * enabled in the user's Telegram notification preferences.  Lives under
 * `src/telegram-notifications/` alongside the rest of the Telegram surface.
 */

"use strict";

const { log } = require("../log");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const telegram = require("./telegram");
const { escapeValue } = require("./telegram-message");

/** Path to the detached sender script, resolved from project root.  We're
 *  in `src/telegram-notifications/`, so the project root is two levels up. */
const _SEND_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "scripts",
  "telegram-send.js",
);

/**
 * Send a Telegram shutdown notification if configured and enabled.
 * Returns quickly; the actual send happens in a detached child.
 */
function notifyShutdown() {
  if (!telegram.isConfigured()) return;
  if (!telegram.getEnabledEvents().shutdown) {
    log.info("[server] Shutdown Telegram notification disabled — skipping");
    return;
  }
  log.info("[server] Sending shutdown notification via Telegram");
  /*- Built twice, the same way `notify` builds its messages: escaped
   *  for MarkdownV2, and raw for the plain-text fallback. The hostname
   *  is escaped for the reason every value is — it is not ours to
   *  choose, and a `-` or `_` in it is markup to MarkdownV2. The rest
   *  of the line is fixed prose, so its own two reserved characters are
   *  written escaped in the template. */
  const host = os.hostname();
  const tail = "is shutting down: Manual restart may be required";
  const msg =
    `*LP Ranger on ${escapeValue(host)}*: ` +
    `The Server \\(includes the Bot\\) ${escapeValue(tail)}\\.`;
  const plain = `*LP Ranger on ${host}*: The Server (includes the Bot) ${tail}.`;
  const child = spawn(
    process.execPath,
    [_SEND_SCRIPT, telegram.getBotToken(), telegram.getChatId(), msg, plain],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

module.exports = { notifyShutdown };
