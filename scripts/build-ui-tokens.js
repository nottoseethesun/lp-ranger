/**
 * @file scripts/build-ui-tokens.js
 * @description Generates `src/client/web/ui-tokens.css` (a generated artifact,
 * gitignored) from `ui-defaults_layout.json`, the dashboard's layout
 * settings, with any operator override applied.
 *
 * The problem this solves: a layout constant that operators should be
 * able to change has to reach CSS, and this project forbids both inline
 * `style="..."` attributes and inline `<style>` blocks (see
 * docs/claude/memory/feedback_css_rules.md). Setting the custom property
 * from JS would write the style attribute on `<html>` — the thing the
 * rule exists to prevent — and would also apply only after the fetch
 * resolved, so a dialog opened during the first second would render
 * unbounded and then jump.
 *
 * Baking it at build time keeps the literal in one place (the JSON),
 * keeps CSS in CSS, and applies on first paint.
 *
 * Emits custom properties only — never rules. Anything that styles an
 * element belongs in the authored stylesheets alongside its neighbours;
 * this file exists purely to carry configured VALUES across the
 * JSON→CSS boundary.
 *
 * Missing or malformed input is fatal: a silently absent token would
 * leave `var(--dialog-max-h)` unresolved, which CSS treats as
 * `max-height: none`, and the dialogs would quietly go back to growing
 * without bound. Failing the build is the only way that stays visible.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("../src/lib/log");
const { loadMergedDefaults } = require("../src/lib/load-merged-defaults");

const OUT = path.join(__dirname, "..", "src", "client", "web", "ui-tokens.css");
const SRC = "ui-defaults_layout.json";

/**
 * Read one positive-integer pixel value out of the merged defaults.
 *
 * @param {object} defaults  Parsed layout settings.
 * @param {string} key       Key to read.
 * @returns {number} The validated value.
 * @throws {Error} When absent or not a positive integer.
 */
function readPxToken(defaults, key) {
  const v = defaults[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(
      `${SRC}: "${key}" must be a positive integer number of pixels ` +
        `(got ${JSON.stringify(v)}).`,
    );
  }
  return v;
}

/**
 * Render the stylesheet.
 *
 * @param {{dialogMaxHeightPx: number}} tokens
 * @returns {string} Full file contents.
 */
function renderCss(tokens) {
  return `/*
 * ui-tokens.css — GENERATED FILE, do not edit by hand.
 *
 * Written by scripts/build-ui-tokens.js from
 * app-config/app-defaults-for-user-configurable/ui-defaults_layout.json
 * (merged with any operator override in app-config/user-configurable/).
 * Edit the JSON and re-run \`npm run build\`.
 *
 * Custom properties only. Rules that style elements live in the
 * authored stylesheets.
 */

:root {
  --dialog-max-h: ${tokens.dialogMaxHeightPx}px;
}
`;
}

function main() {
  const defaults = loadMergedDefaults(SRC);
  const tokens = {
    dialogMaxHeightPx: readPxToken(defaults, "dialogMaxHeightPx"),
  };
  fs.writeFileSync(OUT, renderCss(tokens));
  log.info(
    "[build-ui-tokens] wrote src/client/web/ui-tokens.css (--dialog-max-h: %dpx)",
    tokens.dialogMaxHeightPx,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    log.error("[build-ui-tokens] %s", err.message);
    process.exit(1);
  }
}

module.exports = { readPxToken, renderCss, main };
