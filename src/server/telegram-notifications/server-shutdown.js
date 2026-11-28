/**
 * @file src/server/telegram-notifications/server-shutdown.js
 * @description
 * Fire-and-forget Telegram notifications for the server's shutdown and for
 * a file failure that stops LP Ranger (`notifyFileProblemBeforeExit`); the
 * headless bot (src/bot.js) sends neither.  Extracted from server.js to
 * keep that file within the max-lines budget.
 *
 * Spawns a detached child process (src/telegram-send.js) so the message
 * survives the parent's process.exit().  Each is gated on its event being
 * enabled in the user's Telegram notification preferences: `shutdown` for
 * the shutdown, `otherError` for the file failure.  Lives under
 * `src/server/telegram-notifications/`; the Telegram modules the bot shares
 * are in `src/lib/telegram-notifications/`.
 */

"use strict";

const { log } = require("../../lib/log");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const telegram = require("../../lib/telegram-notifications/telegram");
const {
  escapeValue,
} = require("../../lib/telegram-notifications/telegram-message");

/** Path to the detached sender, `src/telegram-send.js`.  We're in
 *  `src/server/telegram-notifications/`, so `src/` is two levels up.
 *  Exported for the test that checks the sender is there. */
const _SEND_SCRIPT = path.join(__dirname, "..", "..", "telegram-send.js");

/**
 * Build the shutdown message, escaped for MarkdownV2 and again in
 * plain text.
 *
 * Pure, and exported, because the sending half is a `spawn` that a test
 * cannot look inside — so the part with a decision in it is separated
 * from the part with the side effect, and the decision is what gets
 * driven. Every alert the app sends is escaped by `notify`; this message
 * and the test notification (`testConnection`,
 * src/lib/telegram-notifications/telegram.js) are built outside it, so
 * they are the two places where a reserved character in fixed prose can
 * go unnoticed. `test/server-shutdown.test.js` runs the result through
 * Telegram's rule.
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
  _sendDetached(text, plain);
}

/**
 * Send the alert for other errors for a file LP Ranger could not read or
 * write, as the server stops for it (src/lib/stop-on-file-problem.js),
 * when Telegram holds its keys and the alert is on. Sent from a detached
 * process, as the shutdown alert is, since the server may exit at once.
 * Returns quickly.
 * @param {string} words  What LP Ranger could not do to which file, what
 *   to do, and that it stops.
 * @param {string} detail  The error.
 * @param {(text: string, plain: string) => void} [send]  What sends it;
 *   the detached sender unless a test watches the send.
 */
function notifyFileProblemBeforeExit(words, detail, send = _sendDetached) {
  if (!telegram.wouldSend("otherError")) return;
  log.info("[server] Sending the file failure's alert via Telegram");
  const { text, plain } = telegram.alertMessage("otherError", {
    message: words,
    error: detail,
  });
  send(text, plain);
}

/**
 * Hand a message to the detached sender, src/telegram-send.js, which
 * outlives this process's exit.
 * @param {string} text  Escaped for MarkdownV2.
 * @param {string} plain  The same words unescaped, for the fallback.
 */
function _sendDetached(text, plain) {
  const child = spawn(
    process.execPath,
    [_SEND_SCRIPT, telegram.getBotToken(), telegram.getChatId(), text, plain],
    { detached: true, stdio: "ignore" },
  );
  /*-
   *  A sender that cannot start (no file handle left, no node binary)
   *  answers with an 'error' event. With no listener it would throw, and
   *  the server's guard would exit at once, a rebalance under way cut
   *  short, logging the error with its arguments, the Telegram bot token
   *  and chat id among them. Only its code is logged.
   */
  child.on("error", (err) =>
    log.warn("[server] The Telegram sender did not start: %s", err.code),
  );
  child.unref();
}

module.exports = {
  notifyShutdown,
  notifyFileProblemBeforeExit,
  buildShutdownMessage,
  _SEND_SCRIPT,
};
