/**
 * @file src/telegram-notifications/telegram-markdown.js
 * @module telegram-markdown
 * @description
 * Makes arbitrary text safe to send to Telegram as MarkdownV2.
 *
 * Telegram parses a message before delivering it, and refuses the whole
 * message when it cannot. Notifications carry text the app does not
 * control — an error message, a token symbol, an operator's hostname —
 * so any of them can contain a character Telegram reads as markup. The
 * escapes here neutralise those characters, leaving the templates that
 * call in as the only source of actual markup.
 *
 * **MarkdownV2, not the legacy mode.** Telegram calls the original
 * `Markdown` a legacy mode kept for backward compatibility and says to
 * use MarkdownV2 instead. The practical difference is that MarkdownV2
 * publishes a complete escape rule and legacy does not, so MarkdownV2 is
 * the only one a caller can be checked against.
 *
 * **Two contexts, two rules**, both from the Bot API's formatting
 * section. In ordinary text every one of ``_*[]()~`>#+-=|{}.!`` must be
 * preceded by a backslash, and a literal backslash must be doubled.
 * Inside a code span only `` ` `` and `\` are escaped — escaping
 * anything else there renders the backslash instead of hiding it.
 *
 * The heavy lifting is `telegram-escape`, chosen over writing the
 * character list here so the list has one owner. It has one gap: its
 * table covers the eighteen markup characters and omits the backslash,
 * which Telegram also requires. Left alone that is not cosmetic —
 * `a\_b` escapes to `a\\_b`, an escaped backslash followed by a bare
 * underscore, and Telegram refuses the message. So the backslash pass
 * runs FIRST, before any other escape is inserted; running it afterwards
 * would double the backslashes the library had just added.
 */

"use strict";

const { escapeMarkdown } = require("telegram-escape");

/**
 * The parse mode every Telegram send asks for.
 *
 * Exported so the two senders — `telegram.js` and the detached
 * `scripts/telegram-send.js` — cannot drift onto different modes, which
 * is what let the shutdown notification keep the legacy mode after the
 * main path had moved on.
 */
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

module.exports = { PARSE_MODE, escapeValue, escapeCode };
