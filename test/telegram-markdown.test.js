/**
 * @file test/telegram-markdown.test.js
 * @description
 * Proves that what the app sends Telegram is valid MarkdownV2.
 *
 * Telegram parses a message before delivering it and refuses the whole
 * thing when it cannot, so a message that does not parse is an alert
 * that never arrives. The rule it is checked against here is Telegram's
 * own: outside an entity, every one of ``_*[]()~`>#+-=|{}.!`` must be
 * preceded by a backslash, and a literal backslash must itself be
 * escaped.
 *
 * `_bare` below is that rule as a function. It walks the escaped output
 * and reports any reserved character standing on its own — treating a
 * backslash as consuming the character after it, which is exactly what
 * Telegram does, and is why an unescaped backslash is dangerous rather
 * than merely untidy: it eats the escape belonging to the character
 * that follows.
 *
 * The corpus is drawn from what this app actually sends: the ethers
 * error that was lost on Production, real token names off PulseChain,
 * the operator's hostname, and the fee line from the message header.
 *
 * The library doing the work, `telegram-escape`, covers eighteen of the
 * nineteen characters and omits the backslash; `escapeValue` supplies
 * that pass. The cases below are what makes that claim checkable rather
 * than asserted — several of them fail against the library alone.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  PARSE_MODE,
  escapeValue,
  escapeCode,
} = require("../src/telegram-notifications/telegram-markdown");

/** Every character Telegram reserves in ordinary MarkdownV2 text. */
const RESERVED = "_*[]()~`>#+-=|{}.!";

/**
 * Reserved characters left standing on their own in `out`.
 *
 * A backslash consumes the character after it, so `\\` (an escaped
 * backslash) leaves the NEXT character exposed — which is how an
 * unescaped backslash in the input turns a neighbouring escape into a
 * parse error.
 *
 * @param {string} out  Escaped text.
 * @returns {string[]} The offending characters with their offsets.
 */
function _bare(out) {
  const found = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "\\") {
      i++;
      continue;
    }
    if (RESERVED.includes(out[i])) found.push(`${out[i]}@${i}`);
  }
  return found;
}

/** Text this app really sends, including the case that broke Production. */
const CORPUS = [
  [
    "the lost Production error",
    'nonce has already been used (info={ "code": -32000, "message": "STALE: nonce too low" }, code=NONCE_EXPIRED, version=6.17.0)',
  ],
  ["token symbol with underscores", "HEX_from_Ethereum"],
  ["a real PulseChain token name", "NoExpectationsButPumpMyBagsRichardPlease"],
  ["another one", "ChuckNorrisLuigiCIAKilledJFK007Mog"],
  ["the operator's hostname", "lp-ranger-1"],
  ["the fee line's number", "0.25"],
  ["a bare url", "https://example.com/manual#il-guard"],
  ["asterisks in a symbol", "*bold*"],
  ["a tilde", "a ~ b"],
  ["braces", "err {code: 1}"],
  ["backslash before an underscore", "a\\_b"],
  ["backslash before an asterisk", "x\\*y"],
  ["a trailing backslash", "ends with\\"],
  ["a windows path", "C:\\tmp\\file.log"],
  ["json with escaped quotes", 'err: {"msg":"he said \\"no\\""}'],
  ["every reserved character at once", "_*[]()~`>#+-=|{}.!\\"],
];

describe("telegram-markdown — escapeValue", () => {
  it("declares MarkdownV2, the mode with a published escape rule", () => {
    assert.strictEqual(PARSE_MODE, "MarkdownV2");
  });

  for (const [name, input] of CORPUS) {
    it(`leaves nothing unescaped: ${name}`, () => {
      const out = escapeValue(input);
      assert.deepStrictEqual(
        _bare(out),
        [],
        `${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
      );
    });
  }

  it("escapes the backslash, which the library alone does not", () => {
    /*- The specific gap `escapeValue` exists to close. Without its
     *  backslash pass this is `a\\_b`: an escaped backslash, then a
     *  bare underscore, and the message is refused. */
    assert.strictEqual(escapeValue("a\\_b"), "a\\\\\\_b");
  });

  it("keeps the reader's text intact once Telegram unescapes it", () => {
    /*- Escaping must not change what is read. Telegram drops one
     *  backslash before each escaped character, so undoing that has to
     *  return the input exactly. */
    for (const [, input] of CORPUS) {
      const rendered = escapeValue(input).replace(/\\(.)/gs, "$1");
      assert.strictEqual(rendered, String(input));
    }
  });

  it("coerces rather than throwing on a non-string", () => {
    assert.strictEqual(escapeValue(164418), "164418");
    assert.strictEqual(escapeValue(null), "null");
    assert.strictEqual(escapeValue(undefined), "undefined");
  });
});

describe("telegram-markdown — escapeCode", () => {
  it("escapes only the two characters a code span reserves", () => {
    assert.strictEqual(escapeCode("a`b"), "a\\`b");
    assert.strictEqual(escapeCode("a\\b"), "a\\\\b");
  });

  it("leaves the others alone, since a code span renders literally", () => {
    /*- Escaping `_` here would put a visible backslash in the message:
     *  inside a code span Telegram shows the contents as written. */
    assert.strictEqual(escapeCode("0xAbC_123.def-ghi"), "0xAbC_123.def-ghi");
  });

  it("passes a transaction hash through untouched", () => {
    const hash = "0x" + "6da4172cbb14f78a1e902e260052293a".repeat(2);
    assert.strictEqual(escapeCode(hash), hash);
  });
});
