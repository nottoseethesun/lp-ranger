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

const [, , botToken, chatId, text] = process.argv;
if (!botToken || !chatId || !text) process.exit(0);

const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  }),
})
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
