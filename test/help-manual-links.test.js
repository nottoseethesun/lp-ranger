/**
 * @file test/help-manual-links.test.js
 * @description
 * Guards the in-page link integrity of the Help & User Manual.
 *
 * The manual is one long page that leans on internal anchors: the
 * table of contents jumps into it, and entries cross-reference each
 * other (an FAQ answer points at the section that explains the
 * remedy). Nothing else in the suite reads this file and lint does not
 * resolve HTML fragments, so without these tests a renamed `id` or a
 * typo'd `href` ships with every gate green.
 *
 * A dead anchor is a real user-visible defect: the reader clicks a
 * link inside a troubleshooting answer and the page does not move,
 * which reads as a broken app at the exact moment they are already
 * looking for help.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MANUAL = path.join(
  __dirname,
  "..",
  "public",
  "help-and-user-manual.html",
);

/** The manual's raw markup. */
function html() {
  return fs.readFileSync(MANUAL, "utf8");
}

/** Every `id="…"` the document defines. */
function definedIds(src) {
  return new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every distinct in-page `href="#…"` target the document references. */
function referencedAnchors(src) {
  return [...new Set([...src.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))];
}

test("every in-page link resolves to an id in the same document", () => {
  const src = html();
  const ids = definedIds(src);
  const dead = referencedAnchors(src).filter((a) => !ids.has(a));
  assert.deepEqual(dead, [], `dead anchors in the manual: ${dead.join(", ")}`);
});

test("the manual references at least one in-page anchor", () => {
  /*- Without this, a regex that silently stopped matching would make
   *  the test above pass over an empty list forever. */
  assert.ok(
    referencedAnchors(html()).length > 0,
    "expected in-page anchors; the extraction is probably broken",
  );
});

test("Re-scan Prices has a section and the table of contents reaches it", () => {
  const src = html();
  assert.ok(
    definedIds(src).has("re-scan-prices"),
    "the shipped Settings item must be documented",
  );
  assert.match(
    src,
    /<a href="#re-scan-prices">/,
    "the section must be reachable from the table of contents",
  );
});

test("the FAQ answers the inflated-compound-total question", () => {
  /*- The observed symptom (a compounded total that looks too high)
   *  is what a user searches for; the remedy lives under a different
   *  name, so the FAQ has to bridge the two. */
  const src = html();
  const faq = src.slice(
    src.indexOf('<h2 id="faq">'),
    src.indexOf("</ul>", src.indexOf('<h2 id="faq">')),
  );
  assert.match(faq, /compounded total/i, "FAQ must cover the symptom");
  assert.match(
    faq,
    /href="#re-scan-prices"/,
    "the answer must link to the remedy's section",
  );
});
