/**
 * @file test/stylelint-rules/no-linebreak-after-escape.test.js
 * @description Tests for the no-linebreak-after-escape custom stylelint rule.
 *
 * The rule is exercised through `stylelint.lint()` rather than against the
 * exported rule function directly, so the plugin registration, the option
 * validation and the reported positions are all covered by the same path
 * `npm run lint` takes.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const stylelint = require("stylelint");
const plugin = require("../../stylelint-rules/no-linebreak-after-escape");

const RULE = "9mm/no-linebreak-after-escape";

/**
 * Lint one CSS snippet with only this rule enabled.
 *
 * @param {string} code CSS source to lint.
 * @param {boolean|null} [primary] Primary option (defaults to `true`).
 * @returns {Promise<object[]>} Warnings from the single linted source.
 */
async function lint(code, primary = true) {
  const { results } = await stylelint.lint({
    code,
    config: { plugins: [plugin], rules: { [RULE]: primary } },
  });
  return results[0].warnings;
}

describe("no-linebreak-after-escape", () => {
  it("flags a selector whose line ends right after a \\39 escape", async () => {
    const warnings = await lint(
      ".\\39\n  mm-pos-mgr-toggle-track::after {\n  color: red;\n}\n",
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].rule, RULE);
    assert.match(warnings[0].text, /truncat/i);
    // The message names the offending escape and the safe replacement.
    assert.match(warnings[0].text, /\\39/);
    assert.match(warnings[0].text, /\\000039mm-pos-mgr-foo/);
  });

  it("flags every broken escape in a multi-selector rule", async () => {
    /*- The real-world regression: two comma-separated selectors, each
     *  wrapped twice, so four escapes are left stranded at a line end. */
    const warnings = await lint(
      [
        ".\\39",
        "  mm-pos-mgr-privacy-setting",
        "  input:checked",
        "  ~ .\\39",
        "  mm-pos-mgr-toggle-track::after,",
        ".\\39",
        "  mm-pos-mgr-browser-toggle",
        "  input:checked",
        "  ~ .\\39",
        "  mm-pos-mgr-toggle-track::after {",
        "  transform: translateX(27px);",
        "}",
      ].join("\n"),
    );

    assert.strictEqual(warnings.length, 4);
    assert.ok(warnings.every((w) => w.rule === RULE));
  });

  it("reports the position of the escape, not the whole selector", async () => {
    const warnings = await lint(".ok .\\39\n  mm-foo {\n  color: red;\n}\n");

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].line, 1);
    // `.ok .` is five characters, so the backslash sits at column 6 and the
    // three-character `\39` ends just before column 9.
    assert.strictEqual(warnings[0].column, 6);
    assert.strictEqual(warnings[0].endColumn, 9);
  });

  it("flags a six-digit escape stranded at a line end", async () => {
    /*- Six digits need no whitespace terminator, but the spec still eats a
     *  following one — so this form breaks too when the line ends there. */
    const warnings = await lint(".\\000039\n  mm-foo {\n  color: red;\n}\n");

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].text, /\\000039\b/);
  });

  it("flags an escape separated from the line end by a stray space", async () => {
    const warnings = await lint(".\\39 \n  mm-foo {\n  color: red;\n}\n");

    assert.strictEqual(warnings.length, 1);
  });

  it("flags a broken escape in an at-rule prelude", async () => {
    const warnings = await lint(
      "@media (width > 0) {\n  .\\39\n    mm-foo {\n    color: red;\n  }\n}\n",
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].line, 2);
  });

  it("allows the six-digit escape with the identifier continuing", async () => {
    const warnings = await lint(
      [
        ".\\000039mm-pos-mgr-privacy-setting",
        "  input:checked",
        "  ~ .\\000039mm-pos-mgr-toggle-track::after {",
        "  transform: translateX(27px);",
        "}",
      ].join("\n"),
    );

    assert.deepStrictEqual(warnings, []);
  });

  it("allows the ordinary space-terminated escape on one line", async () => {
    /*- The short-line spelling is correct CSS and the stylesheet is full
     *  of it; only the wrapped form is a defect. */
    const warnings = await lint(
      ".\\39 mm-pos-mgr-toggle-track {\n  width: 54px;\n}\n",
    );

    assert.deepStrictEqual(warnings, []);
  });

  it("allows a wrap that falls on a combinator, clear of any escape", async () => {
    const warnings = await lint(
      ".\\39 mm-pos-mgr-privacy-group:hover\n  .\\39 mm-pos-mgr-settings-item {\n  color: #fff;\n}\n",
    );

    assert.deepStrictEqual(warnings, []);
  });

  it("allows escapes inside declaration values", async () => {
    /*- The rule inspects selectors and at-rule preludes only; a `content`
     *  string cannot carry the identifier-truncation hazard. */
    const warnings = await lint('.a::after {\n  content: "\\2014";\n}\n');

    assert.deepStrictEqual(warnings, []);
  });

  it("is a no-op when the rule is switched off", async () => {
    const warnings = await lint(".\\39\n  mm-foo {\n  color: red;\n}\n", null);

    assert.deepStrictEqual(warnings, []);
  });

  it("rejects an unsupported primary option", async () => {
    /*- stylelint keeps option complaints in their own bucket, so this one
     *  is asserted off `invalidOptionWarnings` rather than `warnings`. */
    const { results } = await stylelint.lint({
      code: ".a {\n  color: red;\n}\n",
      config: { plugins: [plugin], rules: { [RULE]: "yes" } },
    });

    assert.strictEqual(results[0].warnings.length, 0);
    assert.strictEqual(results[0].invalidOptionWarnings.length, 1);
    assert.match(results[0].invalidOptionWarnings[0].text, /Invalid option/i);
  });

  it("exports the plugin under its namespaced rule name", () => {
    assert.strictEqual(plugin.ruleName, RULE);
    assert.strictEqual(typeof plugin.rule, "function");
    assert.strictEqual(typeof plugin.rule.messages.rejected, "function");
  });
});

describe("no-linebreak-after-escape — repo stylesheets", () => {
  it("passes on the checked-in CSS", async () => {
    /*- Guards the fix itself: if a formatter re-breaks one of these
     *  selectors, this fails before the toggles do. */
    const { results } = await stylelint.lint({
      files: ["src/client/web/*.css"],
      config: { plugins: [plugin], rules: { [RULE]: true } },
    });

    const offenders = results.flatMap((r) =>
      r.warnings.map((w) => `${r.source}:${w.line}:${w.column}`),
    );

    assert.deepStrictEqual(offenders, []);
  });
});
