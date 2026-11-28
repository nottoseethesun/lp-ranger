"use strict";

/**
 * @file test/css-wallet-strip-disabled.test.js
 * @description Clear Wallet looks disabled while it is (src/client/web/
 *   css/style.css): dimmed, with the help cursor that invites a hover
 *   over the tooltip saying why, and no hover glow. The page disables it
 *   while a Clear would be refused (`paintClearWalletButton`,
 *   src/client/web/js/dashboard-wallet-import.js); without these rules it
 *   would keep its pointer cursor and glow, and a click would do nothing,
 *   with nothing to say so. The Import Wallet buttons, disabled the same
 *   way while an import would be refused, brighten on hover only while
 *   enabled.
 *
 *   Read from the stylesheets themselves: a jsdom page does not compute
 *   the cascade, so this checks the rules the browser applies. The hover
 *   rules are found in either stylesheet the page loads, however a rule's
 *   selector is spaced, listed or nested in `:is()`, and whether it names
 *   a button by its class or by its id.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CSS_DIR = path.join(__dirname, "..", "src", "client", "web", "css");
const CSS = fs.readFileSync(path.join(CSS_DIR, "style.css"), "utf8");
const SHEETS = Object.freeze({
  "style.css": CSS,
  "9mm-pos-mgr.css": fs.readFileSync(
    path.join(CSS_DIR, "9mm-pos-mgr.css"),
    "utf8",
  ),
});

/*- Clear Wallet and the three Import Wallet buttons, by class or by id. */
const BUTTON =
  /(\.(modal-btn|ws-reveal-btn)|#(seedImportBtn|keyImportBtn|genConfirmBtn|wsClearBtn))(?![\w-])/;

/**
 * The declarations of the rule whose selector, at the start of a line,
 * is exactly `selector`, written as style.css writes it (`selector{`).
 * @param {string} selector
 * @returns {string|null}
 */
function ruleBody(selector) {
  const head = `\n${selector}{`;
  const start = CSS.indexOf(head);
  if (start === -1) return null;
  const from = start + head.length;
  return CSS.slice(from, CSS.indexOf("}", from));
}

/**
 * A selector list split at its own commas, not those inside `:is()` or
 * `:not()`, each part with its spaces collapsed.
 * @param {string} list
 * @returns {string[]}
 */
function topLevelParts(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.replace(/\s+/g, " ").trim());
}

/**
 * Every selector of every rule in `css`: comments and statement at-rules
 * (`@import …;`) left out, an at-rule block's own head left out and the
 * rules inside it kept.
 * @param {string} css
 * @returns {string[]}
 */
function selectors(css) {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@[\w-]+[^;{}]*;/g, "");
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    out.push(...topLevelParts(head));
  }
  return out;
}

/** The selectors in `css` that hover one of the buttons. */
function buttonHovers(css) {
  return selectors(css).filter(
    (sel) => BUTTON.test(sel) && sel.includes(":hover"),
  );
}

/** Those of them that would also apply to a disabled button. */
function brightensDisabled(css) {
  return buttonHovers(css).filter((sel) => !/:not\(\s*:disabled\b/.test(sel));
}

const STYLE_SELECTORS = selectors(CSS);

describe("the wallet strip's Clear button", () => {
  it("is dimmed, with the help cursor, while disabled", () => {
    const body = ruleBody(".ws-reveal-btn:disabled");
    assert.notEqual(body, null, "a rule for the disabled button");
    assert.match(body, /opacity\s*:\s*\.5/);
    assert.match(body, /cursor\s*:\s*help/);
  });

  it("glows on hover while enabled", () => {
    assert.ok(STYLE_SELECTORS.includes(".ws-reveal-btn:hover:not(:disabled)"));
  });
});

describe("the Import Wallet buttons", () => {
  /*-
   *  Disabled by their fieldset while an import would be refused, they
   *  take the pointer for their tooltip (src/client/web/css/9mm-pos-mgr.css),
   *  so a bare hover rule would brighten them as if they could be clicked.
   */
  it("brighten on hover while enabled", () => {
    for (const kind of ["primary", "secondary"])
      assert.ok(
        STYLE_SELECTORS.includes(`.modal-btn.${kind}:hover:not(:disabled)`),
        kind,
      );
  });
});

describe("a hover rule for these buttons, in either stylesheet", () => {
  it("applies only while the button is enabled", () => {
    for (const [sheet, css] of Object.entries(SHEETS))
      assert.deepEqual(brightensDisabled(css), [], sheet);
    const seen = Object.values(SHEETS).flatMap(buttonHovers);
    assert.ok(seen.length >= 3, "the enabled hover rules are found");
  });

  it("is found however it is written, and only one that brightens a disabled button is flagged", () => {
    const sample = [
      "@import url(more.css);",
      "#keyImportBtn:hover{opacity:1}",
      ":is(.modal-btn.primary, .other):hover{opacity:1}",
      ".modal-btn.primary:hover:not(:disabled, .busy){opacity:1}",
      "/* .modal-btn:hover{opacity:1} */",
      "@media (width > 1px) { .ws-reveal-btn:hover { opacity: 1 } }",
      ".modal-btn-wide:hover{opacity:1}",
    ].join("\n");
    assert.deepEqual(brightensDisabled(sample), [
      "#keyImportBtn:hover",
      ":is(.modal-btn.primary, .other):hover",
      ".ws-reveal-btn:hover",
    ]);
  });
});
