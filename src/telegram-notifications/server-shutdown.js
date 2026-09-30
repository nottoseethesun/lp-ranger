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
 * Build the shutdown message, escaped for MarkdownV2 and again in
 * plain text.
 *
 * Pure, and exported, because the sending half is a `spawn` that a test
 * cannot look inside — so the part with a decision in it is separated
 * from the part with the side effect, and the decision is what gets
 * driven. Every other message the app sends is escaped by `notify`;
 * this one is not, so it is the one place where a reserved character in
 * fixed prose goes unnoticed. `test/server-shutdown.test.js` runs the
 * result through Telegram's rule.
 *
 * Only ONE value is interpolated and it is escaped: the hostname is not
 * ours to choose, and a `-` or `_` in it is markup to MarkdownV2. The
 * surrounding prose is fixed, so `escapeValue` is applied to it too
 * rather than backslashes being written into the template by hand —
 * hand-escaping is what the test exists to catch, and not doing it is
 * better than catching it.
 *
 * @param {string} [hostname]  Defaults to this machine's.
 * @returns {{text: string, plain: string}}  Escaped form and the same
 *   words unescaped, the pair `sendMessage` wants.
 */
function buildShutdownMessage(hostname = os.hostname()) {
  const lead = "LP Ranger on ";
  const body =
    "The Server (includes the Bot) is shutting down: " +
    "Manual restart may be required.";
  return {
    text: `*${escapeValue(lead)}${escapeValue(hostname)}*: ${escapeValue(body)}`,
    plain: `*${lead}${hostname}*: ${body}`,
  };
}

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
  const { text, plain } = buildShutdownMessage();
  const child = spawn(
    process.execPath,
    [_SEND_SCRIPT, telegram.getBotToken(), telegram.getChatId(), text, plain],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

module.exports = { notifyShutdown, buildShutdownMessage };
