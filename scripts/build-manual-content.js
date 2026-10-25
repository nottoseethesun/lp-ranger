/**
 * @file scripts/build-manual-content.js
 * @description Renders the shared help copy from
 * `src/lib/shared-help-content.json` into `src/client/web/help-and-user-manual.html`,
 * between per-entry marker comments.
 *
 * Single source of truth for the shared copy: the JSON.  Two consumers
 * read it and neither holds its own wording:
 *
 *   - `src/client/web/param-help-content.js` imports it for the in-app circle-i
 *     dialog (esbuild inlines the JSON into the bundle);
 *   - this script writes it into the User Manual, which the app serves
 *     at `/help-and-user-manual.html` and which GitHub Pages publishes.
 *     That published page is what the Telegram alert links to.
 *
 * Rewriting the HTML in place — rather than generating a separate
 * artifact the way `build-disclosure-content.js` does — is deliberate:
 * the manual is a hand-written document that the Pages build copies
 * verbatim, so the rendered section has to live in the file itself.
 *
 * Marker contract, per entry key:
 *
 *     <!-- HELP:inIlGuard:START -->
 *     ...generated, do not edit...
 *     <!-- HELP:inIlGuard:END -->
 *
 * Everything between the markers is replaced on every build.  A key in
 * the JSON with no markers in the HTML is an error, not a silent skip —
 * that combination means someone added shared copy expecting it to
 * appear in the manual and it never would.
 *
 * The configured numbers and names the manual quotes are written by the
 * same build.  `src/lib/help-figures.js` works them out from the shipped JSON;
 * the shared copy's `{{figure:name}}` tokens are filled before it is
 * rendered, each inside a `<span data-figure="name">`, and every such
 * span in the manual's own prose has its text rewritten.  A name the
 * table lacks stops the build.  Every figure being in a span is what lets
 * the copy the app serves be filled again in the browser with the
 * install's own figures, by `src/client/web/dashboard-manual-figures.js`; the copy
 * GitHub Pages publishes keeps the shipped ones.
 *
 * Idempotent: running twice produces the same file.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("../src/lib/log");
const { loadShippedDefaults } = require("../src/lib/load-merged-defaults");
const { aggregatorNameInUse } = require("../src/lib/aggregator-in-use");
const {
  helpFigures,
  fillEntryFigures,
  spanFigureTokens,
  fillFigureSpans,
} = require("../src/lib/help-figures");

const JSON_SRC = path.join(
  __dirname,
  "..",
  "src",
  "lib",
  "shared-help-content.json",
);
const HTML = path.join(
  __dirname,
  "..",
  "src",
  "client",
  "web",
  "help-and-user-manual.html",
);

/**
 * Render one shared entry as manual HTML.
 *
 * An entry with a `manualHeading` is a whole section: an `<h2>` whose id
 * is the entry's `manualAnchor`, then its sections. An entry without one
 * is part of a section the manual writes by hand, and renders as its
 * sections alone, wherever the manual puts its markers.
 *
 * Each section's `heading` becomes an `<h3>` and its `body` is emitted
 * as-is — it already carries the same inline HTML the dialog renders,
 * which is what keeps the two presentations identical rather than merely
 * similar.
 *
 * @param {{manualHeading?: string, manualAnchor?: string,
 *          sections: {heading: string, body: string}[]}} entry
 * @returns {string}
 */
function renderEntry(entry) {
  const lines = [];
  if (typeof entry.manualHeading === "string")
    lines.push(`  <h2 id="${entry.manualAnchor}">${entry.manualHeading}</h2>`);
  lines.push(
    "  <!-- Generated from src/lib/shared-help-content.json by",
    "       scripts/build-manual-content.js. Do not edit between the",
    "       markers; edit the JSON. -->",
  );
  for (const s of entry.sections) {
    lines.push(`  <h3>${s.heading}</h3>`);
    lines.push(`  <p>${s.body}</p>`);
  }
  return lines.join("\n");
}

/**
 * Replace the marked region for one key.  Throws when the markers are
 * absent or malformed — see the file header on why this is not a skip.
 * @param {string} html
 * @param {string} key
 * @param {string} rendered
 * @returns {string}
 */
function replaceRegion(html, key, rendered) {
  const start = `<!-- HELP:${key}:START -->`;
  const end = `<!-- HELP:${key}:END -->`;
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i === -1 || j === -1 || j < i)
    throw new Error(
      `help-and-user-manual.html is missing a well-formed ${start} … ${end} region`,
    );
  return (
    html.slice(0, i + start.length) + "\n" + rendered + "\n  " + html.slice(j)
  );
}

/**
 * The keys of `data` that are help entries.
 *
 * Selected by SHAPE — an object carrying a `sections` array — not by a
 * naming convention.  The file also holds `_comment` keys and
 * `manualBaseUrl`, and an earlier "everything not underscore-prefixed"
 * filter swept `manualBaseUrl` in and crashed the build the moment it
 * was added.  Shape cannot drift the way a prefix rule can.
 *
 * @param {object} data  Parsed shared-help-content.json.
 * @returns {string[]}
 */
function helpKeys(data) {
  return Object.keys(data).filter(
    (k) =>
      data[k] && typeof data[k] === "object" && Array.isArray(data[k].sections),
  );
}

/**
 * The figures the help quotes, from the shipped JSON: what an install
 * runs on before any override or `.env` value, on the chain it ships
 * set to (`defaults.chain`). They are what the copy GitHub Pages
 * publishes states. The copy the app serves is filled again in the
 * browser with the install's own (`src/client/web/dashboard-manual-figures.js`).
 * @returns {Readonly<Record<string, string>>}
 */
function shippedFigures() {
  const runtime = loadShippedDefaults("app-runtime.json");
  const chainKey = runtime.defaults.chain;
  const chain = loadShippedDefaults("chains.json")[chainKey];
  return helpFigures({
    botDefaults: loadShippedDefaults("bot-config-defaults.json"),
    settingBounds: loadShippedDefaults("setting-bounds.json"),
    uiDefaults: loadShippedDefaults(
      "ui-defaults_non-layout_for-server-up-scenario.json",
    ),
    appRuntime: runtime,
    txSpeedupSec: runtime.tx.speedupSec,
    // As src/lib/config.js derives it when TX_CANCEL_SEC is not set.
    txCancelSec: runtime.tx.deadlineSec * runtime.tx.cancelToDeadlineMultiple,
    compoundMinFeeUsd: runtime.compound.minFeeUsd,
    chainKey,
    chainName: chain.displayName,
    aggregatorName: aggregatorNameInUse(
      chain.aggregator.url,
      chain.aggregator.name,
    ),
  });
}

/**
 * The manual as the build leaves it, worked out in memory: every shared
 * entry rendered into its region with its figures filled, and every
 * figure span in the manual's own prose rewritten.  Pure, so a test can
 * compare the file against it without writing a tracked file.
 * @param {string} html  The manual as it stands.
 * @param {object} data  Parsed shared-help-content.json.
 * @param {Record<string, string>} figures  From `helpFigures`.
 * @returns {string}
 */
function render(html, data, figures) {
  let out = html;
  for (const key of helpKeys(data)) {
    const entry = fillEntryFigures(data[key], figures, spanFigureTokens);
    out = replaceRegion(out, key, renderEntry(entry));
  }
  return fillFigureSpans(out, figures);
}

/**
 * Render every shared entry into the manual, and write the figures the
 * manual quotes.  Returns the entry count.
 */
function build() {
  const data = JSON.parse(fs.readFileSync(JSON_SRC, "utf8"));
  const html = fs.readFileSync(HTML, "utf8");
  fs.writeFileSync(HTML, render(html, data, shippedFigures()));
  return helpKeys(data).length;
}

if (require.main === module) {
  const n = build();
  log.info(
    "[build-manual-content] rendered %d shared help entr%s into %s",
    n,
    n === 1 ? "y" : "ies",
    path.relative(path.join(__dirname, ".."), HTML),
  );
}

module.exports = {
  build,
  helpKeys,
  render,
  renderEntry,
  replaceRegion,
  shippedFigures,
};
