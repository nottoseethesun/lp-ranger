/**
 * @file test/eslint-rules/no-interpolated-innerhtml.test.js
 * @description Tests for the no-interpolated-innerhtml custom ESLint rule.
 */

"use strict";

const { describe, it } = require("node:test");
const { RuleTester } = require("eslint");
const rule = require("../../eslint-rules/no-interpolated-innerhtml");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("no-interpolated-innerhtml", () => {
  it("passes RuleTester valid/invalid cases", () => {
    ruleTester.run("no-interpolated-innerhtml", rule, {
      valid: [
        // Empty string clear
        { code: `el.innerHTML = "";` },
        // Static literal markup
        { code: `el.innerHTML = "<span>hello</span>";` },
        // Trusted constant reference (Identifier)
        { code: `body.innerHTML = DISCLOSURE_HTML;` },
        // Trusted property reference (MemberExpression)
        { code: `node.innerHTML = s.body;` },
        // Template literal with no expressions is allowed
        { code: "el.innerHTML = `<static>markup</static>`;" },
        // Other member assignments are ignored
        { code: `el.textContent = "<span>" + x + "</span>";` },
        // insertAdjacentHTML with static string
        { code: `el.insertAdjacentHTML("beforeend", "<li>item</li>");` },
        // insertAdjacentHTML with trusted identifier
        { code: `el.insertAdjacentHTML("beforeend", TRUSTED_HTML);` },
      ],

      invalid: [
        // Template literal with interpolation → innerHTML
        {
          code: "el.innerHTML = `<span>${name}</span>`;",
          errors: [{ messageId: "interpolated" }],
        },
        // String concat → innerHTML
        {
          code: `el.innerHTML = "<tag>" + x + "</tag>";`,
          errors: [{ messageId: "interpolated" }],
        },
        // Template literal with interpolation → outerHTML
        {
          code: "el.outerHTML = `<div>${x}</div>`;",
          errors: [{ messageId: "interpolated" }],
        },
        // insertAdjacentHTML with interpolated template literal
        {
          code: 'el.insertAdjacentHTML("beforeend", `<li>${n}</li>`);',
          errors: [{ messageId: "interpolated" }],
        },
        // insertAdjacentHTML with concat
        {
          code: `el.insertAdjacentHTML("beforeend", "<li>" + n + "</li>");`,
          errors: [{ messageId: "interpolated" }],
        },
      ],
    });
  });
});
