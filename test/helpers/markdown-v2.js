"use strict";

/**
 * @file test/helpers/markdown-v2.js
 * @description
 * Telegram's MarkdownV2 rule, as something a test can run.
 *
 * One copy, shared by every test that checks a message the app is about
 * to send. A second copy would be a mirror, and this one has already
 * been wrong once in a way that only showed when the inputs changed —
 * so the version that gets fixed must be the version everyone uses.
 *
 * The rule, from the Bot API's formatting section:
 *
 *   - In ordinary text, every one of ``_*[]()~`>#+-=|{}.!`` must be
 *     preceded by a backslash, and a literal backslash must be doubled.
 *   - **Inside a code span only `` ` `` and `\` are reserved.** Escaping
 *     anything else there is wrong, because a code span renders its
 *     contents literally and the backslash would be shown to the reader.
 *   - `*` and `` ` `` are also the delimiters the app's own templates
 *     use, so those may stand unescaped — but must pair up, since an
 *     odd one is an unterminated entity and a parse error.
 *
 * The code-span clause is the part that matters and the part that was
 * missing: a checker that walks the string uniformly reports a hash like
 * `` `0xAbC_123` `` as broken when it is correct. A checker that cries
 * wolf gets loosened until it stops saying anything, which is worse than
 * not having one.
 */

const assert = require("node:assert/strict");

/** Every character Telegram reserves in ordinary MarkdownV2 text. */
const RESERVED = "_*[]()~`>#+-=|{}.!";

/**
 * Analyse one message against the rule above.
 *
 * @param {string} text  The message as it would be sent.
 * @returns {{violations: string[], bold: number, code: number,
 *   unterminated: boolean}}  `violations` lists reserved characters
 *   standing unescaped in ordinary text, as `char@offset`. `bold` and
 *   `code` count the unescaped delimiters. `unterminated` is true when a
 *   code span is left open.
 */
function markdownV2Report(text) {
  const violations = [];
  let bold = 0;
  let code = 0;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      /*- A backslash consumes the character after it. `\\` therefore
       *  leaves the NEXT character exposed, which is how an unescaped
       *  backslash turns a neighbouring escape into a parse error. */
      i++;
      continue;
    }
    if (c === "`") {
      inCode = !inCode;
      code++;
      continue;
    }
    if (inCode) continue;
    if (c === "*") {
      bold++;
      continue;
    }
    if (RESERVED.includes(c)) violations.push(`${c}@${i}`);
  }
  return { violations, bold, code, unterminated: inCode };
}

/**
 * Assert that a message is valid MarkdownV2, failing with the offending
 * characters and the message itself.
 *
 * Exported as an assertion rather than a predicate so the checks that
 * make up "valid" cannot be copied into each test and drift apart.
 *
 * There are three, not four. An unterminated code span and an odd
 * count of code delimiters are the same fact stated twice: `inCode` is
 * toggled on exactly the characters that increment `code`, both from a
 * standing start, so `unterminated === (code % 2 === 1)` for every
 * possible input. Asserting both reads as more coverage than it is.
 *
 * @param {string} text   The message as it would be sent.
 * @param {string} label  What is being checked, for the failure message.
 * @returns {void}
 */
function assertValidMarkdownV2(text, label) {
  const { violations, bold, unterminated } = markdownV2Report(text);
  assert.deepStrictEqual(
    violations,
    [],
    `${label}: unescaped in ordinary text — ${JSON.stringify(text)}`,
  );
  assert.strictEqual(
    unterminated,
    false,
    `${label}: unterminated code span — ${JSON.stringify(text)}`,
  );
  assert.strictEqual(bold % 2, 0, `${label}: bold delimiters must pair`);
}

module.exports = { RESERVED, markdownV2Report, assertValidMarkdownV2 };
