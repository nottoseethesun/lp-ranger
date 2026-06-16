/**
 * @file scripts/build-disclosure-content.js
 * @description Extracts the disclosure body from public/disclosure.html and
 * generates public/disclosure-content.js (a generated artifact, gitignored).
 *
 * Single source of truth for disclosure text: public/disclosure.html.
 * The standalone HTML serves a GitHub Pages deployment; the generated JS
 * feeds the in-app startup modal and Settings &rarr; Disclosure item.
 *
 * Extraction contract:
 *   - Content is everything between the HTML comment markers
 *       <!-- DISCLOSURE:CONTENT:START -->
 *       <!-- DISCLOSURE:CONTENT:END -->
 *   - Version is parsed from the literal text "Disclosure version: YYYY-MM-DD"
 *     inside that region. This keeps the HTML human-readable without a
 *     separate out-of-band marker.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "disclosure.html");
const OUT = path.join(__dirname, "..", "public", "disclosure-content.js");

const START = "<!-- DISCLOSURE:CONTENT:START -->";
const END = "<!-- DISCLOSURE:CONTENT:END -->";

function extract(html) {
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `disclosure.html is missing content markers (${START} / ${END}).`,
    );
  }
  return html.slice(s + START.length, e).trim();
}

function parseVersion(content) {
  const m = content.match(/Disclosure version:\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) {
    throw new Error(
      'disclosure.html is missing a "Disclosure version: YYYY-MM-DD" line.',
    );
  }
  return m[1];
}

function renderModule(version, content) {
  // Escape backticks and ${ so the string can live inside a template literal.
  const escaped = content
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `/**
 * @file disclosure-content.js
 * @description GENERATED FILE &mdash; do not edit by hand.
 * Built by scripts/build-disclosure-content.js from public/disclosure.html.
 */

/** Disclosure version &mdash; parsed from public/disclosure.html. */
export const DISCLOSURE_VERSION = ${JSON.stringify(version)};

/** Full disclosure HTML, rendered into the modal body. */
export const DISCLOSURE_HTML = \`
${escaped}
\`;
`;
}

function main() {
  const html = fs.readFileSync(SRC, "utf8");
  const content = extract(html);
  const version = parseVersion(content);
  const out = renderModule(version, content);
  fs.writeFileSync(OUT, out);
  log.info(
    `[npm run build process][build-disclosure-content] wrote ${path.relative(process.cwd(), OUT)} (version ${version}, ${content.length} chars)`,
  );
}

main();
