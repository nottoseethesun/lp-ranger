"use strict";

/**
 * @file test/dashboard-manual-figures.test.js
 * @description The User Manual the app serves states the figures this
 *   install runs on; the copy GitHub Pages publishes states the shipped
 *   ones.
 *
 *   The manual's build writes the shipped figures into every
 *   `<span data-figure="name">`, the shared Impermanent Loss Guard
 *   section's included. The served copy loads
 *   `public/dashboard-manual-figures.js`, which asks
 *   `GET /api/help-figures` and rewrites each span; the Pages build drops
 *   the tag that loads it. Each half is checked here: the module under
 *   jsdom with a scripted fetch, the built manual for its spans, and the
 *   Pages spec for the rewrite.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MANUAL = fs.readFileSync(
  path.join(ROOT, "public", "help-and-user-manual.html"),
  "utf8",
);
const TAG =
  '<script type="module" src="/dashboard-manual-figures.js"></script>';

let mod;
const warned = [];

before(async () => {
  /*-
   *  The module asks the server as soon as it loads, as the manual
   *  does. That first ask is answered "not found", as a static copy
   *  would answer it, and must change nothing.
   */
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    mod = await import("../public/dashboard-manual-figures.js");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = realWarn;
  }
});

/** The manual's body in the document. */
function mountManual() {
  document.body.innerHTML = MANUAL.slice(
    MANUAL.indexOf("<body"),
    MANUAL.lastIndexOf("</body>"),
  );
}

/** Every figure span's text, by name. */
function spanTexts(name) {
  return [...document.querySelectorAll(`[data-figure="${name}"]`)].map(
    (el) => el.textContent,
  );
}

describe("the manual the app serves", () => {
  it("loads the module that fills its figures", () => {
    assert.ok(MANUAL.includes(TAG));
  });

  it("puts every figure in a span, the shared section's included", () => {
    const shared = MANUAL.slice(
      MANUAL.indexOf("<!-- HELP:inIlGuard:START -->"),
      MANUAL.indexOf("<!-- HELP:inIlGuard:END -->"),
    );
    assert.match(shared, /<span data-figure="ilgDefaultPct">[^<]+<\/span>/);
    assert.doesNotMatch(shared, /\{\{figure:/);
  });

  it("says why when the server does not answer, and keeps the shipped figures", () => {
    assert.equal(warned.length, 1);
    assert.match(warned[0], /HTTP 404/);
    assert.match(warned[0], /shipped/);
  });

  it("writes the install's figures into every span", async () => {
    mountManual();
    const before = spanTexts("ilgDefaultPct");
    assert.ok(before.length > 0);
    const figures = {};
    for (const el of document.querySelectorAll("[data-figure]"))
      figures[el.dataset.figure] = `x-${el.dataset.figure}`;
    await mod.fillManualFigures(async (url) => {
      assert.equal(url, "/api/help-figures");
      return { ok: true, json: async () => ({ figures, botDefaults: {} }) };
    });
    for (const el of document.querySelectorAll("[data-figure]"))
      assert.equal(el.textContent, `x-${el.dataset.figure}`);
  });
});

describe("the copy GitHub Pages publishes", () => {
  it("drops the tag, keeping the shipped figures the build wrote", () => {
    const spec = fs.readFileSync(
      path.join(ROOT, ".github", "pages-site.yml"),
      "utf8",
    );
    assert.ok(spec.includes(`from: '  ${TAG}'`), "the rewrite names the tag");
    const rewritten = MANUAL.split(`  ${TAG}`).join("");
    assert.ok(!rewritten.includes("dashboard-manual-figures.js"));
  });
});
