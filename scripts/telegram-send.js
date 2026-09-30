/**
 * @file scripts/telegram-send.js
 * @description Standalone one-shot Telegram message sender.
 *
 * Designed to be spawned as a detached child process during server
 * shutdown so the notification survives the parent's exit. That is the
 * whole of its job: the escaping, the parse mode and the plain-text
 * fallback all belong to `src/telegram-notifications/telegram-message.js`,
 * which this calls, so this path cannot drift away from the in-process
 * one the way it did when each had its own `fetch`.
 *
 * Usage: node scripts/telegram-send.js <botToken> <chatId> <escaped> [plain]
 *
 * `escaped` is already escaped for MarkdownV2 by the caller, which is
 * the only side that knows which characters are markup and which are
 * text. `plain` is the same words unescaped, for the fallback; omitting
 * it sends the escaped form both times.
 */

"use strict";

const {
  sendMessage,
} = require("../src/telegram-notifications/telegram-message");

const [, , botToken, chatId, text, plainText] = process.argv;
if (!botToken || !chatId || !text) process.exit(0);

sendMessage({ botToken, chatId, text, plainText })
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch(() => process.exit(1));
