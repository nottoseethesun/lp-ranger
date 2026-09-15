/**
 * @file eslint-rules/no-unescaped-digit-class-selector.js
 * @description ESLint rule that flags a CSS class selector beginning
 *   with a digit passed to a DOM query method without escaping.
 *
 * Every custom class in this project is prefixed `9mm-pos-mgr-`, so
 * every one of them starts with a digit. That is perfectly legal in a
 * `class` attribute, and illegal in a CSS selector unless the leading
 * digit is escaped. `querySelector(".9mm-pos-mgr-x")` does not return
 * null — it throws a DOMException.
 *
 * The failure is nasty out of proportion to the typo:
 *
 *   - it throws rather than returning nothing, so it takes out whatever
 *     ran after it in the same function;
 *   - inside an async function with no `await` at the call site, it
 *     becomes an unhandled rejection nobody sees;
 *   - it only fires on the branch that runs the query, so it survives
 *     every other test and every other page view.
 *
 * That is exactly how one shipped: a dialog helper looked its row up
 * with `closest(".9mm-pos-mgr-moralis-use-row")` and threw before
 * setting the control it existed to set, leaving a switch showing the
 * raw HTML defaults and reflecting nothing.
 *
 * Rejects:
 *   el.closest(".9mm-pos-mgr-row")
 *   document.querySelector(".9mm-pos-mgr-row > span")
 *   el.matches(".9mm-pos-mgr-row")
 *
 * Allows:
 *   el.closest(".\\39 mm-pos-mgr-row")      // escaped, valid
 *   document.getElementById("someId")       // the preferred route
 *   el.querySelector("[data-rpc]")          // attribute selectors
 *   el.querySelector(".plain-class")        // no leading digit
 */

"use strict";

/** DOM methods that parse their first argument as a CSS selector. */
const _QUERY_METHODS = new Set([
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
]);

/*- A class selector whose first character after the dot is a digit and
 *  is NOT part of an escape sequence.  In an escaped selector the dot is
 *  followed by a backslash (`.\39 mm-…`), so requiring a digit
 *  immediately after the dot is enough to tell them apart. */
const _BAD_CLASS = /\.\d/;

/**
 * Does this string contain an unescaped digit-leading class selector?
 * @param {string} s  Selector text.
 * @returns {boolean}
 */
function hasUnescapedDigitClass(s) {
  return typeof s === "string" && _BAD_CLASS.test(s);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unescaped digit-leading class selectors in DOM queries",
    },
    schema: [],
    messages: {
      unescaped:
        'Selector "{{selector}}" starts a class with a digit, which throws a ' +
        "DOMException at runtime. Use getElementById, or escape it as " +
        '".\\39 mm-pos-mgr-…".',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (!_QUERY_METHODS.has(callee.property.name)) return;

        const arg = node.arguments[0];
        if (!arg) return;

        /*- Only literal selectors can be judged here.  A selector built
         *  at runtime is out of reach of static analysis; the id-based
         *  lookups this rule steers people toward avoid the problem
         *  entirely. */
        let text = null;
        if (arg.type === "Literal") text = arg.value;
        else if (arg.type === "TemplateLiteral" && arg.expressions.length === 0)
          text = arg.quasis[0].value.cooked;

        if (hasUnescapedDigitClass(text)) {
          context.report({
            node: arg,
            messageId: "unescaped",
            data: { selector: String(text) },
          });
        }
      },
    };
  },
};
