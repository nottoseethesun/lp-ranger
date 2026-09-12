/**
 * @file test/eslint-rules/no-unescaped-digit-class-selector.test.js
 * @description RuleTester cases for the digit-leading class selector
 *   rule.
 *
 * The rule exists because every custom class in this project is
 * prefixed `9mm-pos-mgr-`, so every one of them starts with a digit —
 * fine in a `class` attribute, illegal in an unescaped CSS selector.
 * `closest(".9mm-…")` throws a DOMException rather than returning null,
 * which takes out whatever ran after it and, in an async helper nobody
 * awaits, does so silently.
 */

"use strict";

const { RuleTester } = require("eslint");
const { describe, it } = require("node:test");

const rule = require("../../eslint-rules/no-unescaped-digit-class-selector");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("no-unescaped-digit-class-selector", () => {
  it("passes RuleTester", () => {
    ruleTester.run("no-unescaped-digit-class-selector", rule, {
      valid: [
        /*- The route the rule steers toward: no selector parsing at all. */
        { code: 'document.getElementById("moralisEnabledRow");' },
        /*- Properly escaped — this is what the CSS files themselves use. */
        { code: 'el.closest(".\\\\39 mm-pos-mgr-row");' },
        /*- Ordinary classes are unaffected. */
        { code: 'document.querySelector(".modal-overlay");' },
        { code: 'el.matches(".rpc-combo-input");' },
        /*- Attribute and element selectors have no leading-digit problem. */
        { code: 'el.querySelector("[data-rpc]");' },
        { code: 'document.querySelectorAll("li");' },
        /*- Ids may legally start with a digit in this selector position
         *  only via escaping too, but getElementById takes a raw id and
         *  is not a selector method — out of scope. */
        { code: 'document.getElementById("9mm-thing");' },
        /*- Not a DOM query method. */
        { code: 'thing.includes(".9mm-pos-mgr-row");' },
        { code: 'log(".9mm-pos-mgr-row");' },
        /*- Runtime-built selectors cannot be judged statically; the rule
         *  deliberately says nothing rather than guessing. */
        { code: "el.closest(sel);" },
        { code: "el.closest(`.${prefix}-row`);" },
      ],
      invalid: [
        {
          code: 'el.closest(".9mm-pos-mgr-moralis-use-row");',
          errors: [{ messageId: "unescaped" }],
        },
        {
          code: 'document.querySelector(".9mm-pos-mgr-row > span");',
          errors: [{ messageId: "unescaped" }],
        },
        {
          code: 'document.querySelectorAll(".9mm-pos-mgr-card");',
          errors: [{ messageId: "unescaped" }],
        },
        {
          code: 'el.matches(".9mm-pos-mgr-row");',
          errors: [{ messageId: "unescaped" }],
        },
        /*- A static template literal is just as broken as a quoted
         *  string, and just as checkable. */
        {
          code: "el.closest(`.9mm-pos-mgr-row`);",
          errors: [{ messageId: "unescaped" }],
        },
        /*- The bad class need not be first in the selector. */
        {
          code: 'document.querySelector("div .9mm-pos-mgr-row");',
          errors: [{ messageId: "unescaped" }],
        },
      ],
    });
  });
});
