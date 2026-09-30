/**
 * @file scripts/telegram-send.js
 * @description Standalone one-shot Telegram message sender.
 *
 * Designed to be spawned as a detached child process during server shutdown
 * so the notification survives the parent's exit.
 *
 * Usage: node scripts/telegram-send.js <botToken> <chatId> <message>
 */

"use strict";

const {
  PARSE_MODE,
} = require("../src/telegram-notifications/telegram-markdown");

const [, , botToken, chatId, text] = process.argv;
if (!botToken || !chatId || !text) process.exit(0);

/*- The parse mode comes from the shared module rather than a literal
 *  here. This sender is a second road to Telegram, spawned detached so
 *  the message outlives the parent, and a mode written out twice is a
 *  mode that moves in one place only — which is how this path stayed on
 *  the legacy one after the main path had left it. The caller escapes
 *  the text; this script only delivers it. */
const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: PARSE_MODE,
    disable_web_page_preview: true,
  }),
})
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
