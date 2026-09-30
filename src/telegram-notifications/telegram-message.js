/**
 * @file src/telegram-notifications/telegram-message.js
 * @module telegram-message
 * @description
 * The one road to Telegram: how a message is escaped, and how it is
 * sent.
 *
 * Both halves live here together because they are one decision. The
 * escape only works for the parse mode the send asks for, and a sender
 * that picks its own mode is a sender that can silently disagree with
 * the escaping — which is what happened. There were two senders, the
 * ordinary one and the detached shutdown one, each with its own
 * `fetch` and its own hardcoded mode, so a fix applied to the first
 * never reached the second.
 *
 * Nothing here reads module state. Credentials arrive as arguments, so
 * the detached `scripts/telegram-send.js`, which gets them on its
 * command line, can use the same function as the in-process caller
 * that holds them in memory.
 *
 * ## Escaping
 *
 * **MarkdownV2, not the legacy mode.** Telegram calls the original
 * `Markdown` a legacy mode kept for backward compatibility and says to
 * use MarkdownV2 instead. The practical difference is that MarkdownV2
 * publishes a complete escape rule and legacy does not, so MarkdownV2
 * is the only one a caller can be checked against.
 *
 * **Two contexts, two rules**, both from the Bot API's formatting
 * section. In ordinary text every one of ``_*[]()~`>#+-=|{}.!`` must be
 * preceded by a backslash, and a literal backslash must be doubled.
 * Inside a code span only `` ` `` and `\` are escaped — escaping
 * anything else there renders the backslash instead of hiding it.
 *
 * The character table is `telegram-escape`'s, so the list has one
 * owner. It has one gap: it covers the eighteen markup characters and
 * omits the backslash, which Telegram also requires. Left alone that is
 * not cosmetic — `a\_b` escapes to `a\\_b`, an escaped backslash
 * followed by a bare underscore, and Telegram refuses the message. So
 * the backslash pass runs FIRST, before any other escape is inserted;
 * running it afterwards would double the backslashes the library had
 * just added.
 *
 * ## Sending
 *
 * Escaping is a claim about correctness, not a guarantee, so the send
 * keeps a fallback under it: a refusal that names a parse error is
 * retried once with no parse mode at all. That retry carries the
 * UNESCAPED words, which is why `sendMessage` wants both forms — the
 * escaped text rendered without a parse mode would show every
 * backslash to the reader.
 *
 * The formatting is what gets sacrificed, never the alert.
 */

"use strict";

const { escapeMarkdown } = require("telegram-escape");
const { log } = require("../log");

/** The parse mode every Telegram send asks for. */
const PARSE_MODE = "MarkdownV2";

/**
 * Escape one value for ordinary MarkdownV2 text.
 *
 * Apply to every interpolated value, never to the assembled message:
 * the template's own `*` and backticks are the markup and must survive.
 *
 * @param {*} text  Coerced with String(), so a number or null is safe.
 * @returns {string} Text that cannot be read as markup.
 */
function escapeValue(text) {
  /*- Backslash first — see the file header. `split`/`join` rather than a
   *  regex because the replacement is itself backslashes, and every
   *  regex form of that needs its own second layer of escaping to read
   *  correctly. */
  const backslashed = String(text).split("\\").join("\\\\");
  return escapeMarkdown(backslashed);
}

/**
 * Escape one value for use INSIDE a code span.
 *
 * Only the two characters Telegram names for that context. Running the
 * ordinary escape here would be wrong in a way that shows: a code span
 * renders its contents literally, so the backslashes would appear in
 * the message.
 *
 * @param {*} text  Coerced with String().
 * @returns {string} Text safe between backticks.
 */
function escapeCode(text) {
  return String(text).split("\\").join("\\\\").split("`").join("\\`");
}

/**
 * Post one message to the Bot API.
 *
 * @param {string} url        The sendMessage endpoint.
 * @param {string} chatId     Chat to deliver to.
 * @param {string} text       Message text.
 * @param {string|null} mode  `parse_mode` to request, or null for none.
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 *   `status` is 0 and `body` the error message when the request itself
 *   could not be made.
 */
async function _post(url, chatId, text, mode) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (mode) payload.parse_mode = mode;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true, status: res.status, body: "" };
    return {
      ok: false,
      status: res.status,
      body: await res.text().catch(() => ""),
    };
  } catch (err) {
    return { ok: false, status: 0, body: err.message };
  }
}

/**
 * Whether Telegram rejected a message because it could not parse the
 * formatting, as opposed to any other refusal.
 *
 * Telegram answers 400 with a description naming the offending byte —
 * "can't parse entities: Can't find end of the entity starting at byte
 * offset 597". Matched on the phrase rather than the status, because a
 * 400 also covers a bad chat id, which resending fixes nothing about.
 *
 * @param {{status: number, body: string}} res  A failed `_post` result.
 * @returns {boolean}
 */
function _isParseFailure(res) {
  return res.status === 400 && /can't parse entities/i.test(res.body);
}

/**
 * Send one message to Telegram, formatted if it will take it and plain
 * if it will not.
 *
 * Every sender in the app goes through here, including the detached
 * shutdown script, so all of them share the parse mode, the fallback
 * and the log wording.
 *
 * @param {object} opts
 * @param {string} opts.botToken   Bot API token.
 * @param {string} opts.chatId     Chat to deliver to.
 * @param {string} opts.text       Message, escaped for `PARSE_MODE`.
 * @param {string} [opts.plainText]  The same words unescaped, for the
 *   retry. Omit when the two are identical.
 * @returns {Promise<boolean>} True when Telegram accepted it.
 */
async function sendMessage({ botToken, chatId, text, plainText }) {
  if (!botToken || !chatId) return false;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const plain = plainText === undefined ? text : plainText;
  const first = await _post(url, chatId, text, PARSE_MODE);
  if (first.ok) {
    log.info("[telegram] Notification sent: %s", plain.split("\n")[0]);
    return true;
  }
  if (!_isParseFailure(first)) {
    /*- Status 0 is `_post` reporting that the request could not be made
     *  at all, which is a different thing from Telegram refusing one
     *  and keeps the wording it has always had. */
    if (first.status === 0) log.warn("[telegram] Send error: %s", first.body);
    else log.warn("[telegram] Send failed: %d %s", first.status, first.body);
    return false;
  }
  log.warn(
    "[telegram] Markdown refused (%s) — resending as plain text",
    first.body,
  );
  const retry = await _post(url, chatId, plain, null);
  if (retry.ok) {
    log.info(
      "[telegram] Notification sent unformatted: %s",
      plain.split("\n")[0],
    );
    return true;
  }
  /*- Both attempts refused, so this alert is lost. Logged at error
   *  level because nothing downstream reports it and the operator's
   *  only other sign would be the silence itself. */
  log.error(
    "[telegram] Send failed after plain-text retry: %d %s",
    retry.status,
    retry.body,
  );
  return false;
}

module.exports = { PARSE_MODE, escapeValue, escapeCode, sendMessage };
