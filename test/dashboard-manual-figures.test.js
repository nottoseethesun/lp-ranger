"use strict";

/**
 * @file test/dashboard-manual-figures.test.js
 * @description The User Manual the app serves states the figures this
 *   install runs on; the copy GitHub Pages publishes states the shipped
 *   ones.
 *
 *   The manual's build writes the shipped figures into every
 *   `<span data-figure="name">`, the shared Impermanent Loss Guard
 *   section's included. The served copy loads the build's stamped bundle
 *   of `src/client/web/dashboard-manual-figures.js`, which asks
 *   `GET /api/help-figures` and rewrites each span; the Pages build drops
 *   the tag that loads it, and makes the stylesheets relative and
 *   unstamped. Each half is checked here: the module under jsdom with a
 *   scripted fetch, the built manual for its spans and its tag, and the
 *   Pages build's own page writer.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { readSpec, writePage } = require("../scripts/build-pages-site");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const ROOT = path.join(__dirname, "..");
const MANUAL = fs.readFileSync(
  path.join(ROOT, "src", "client", "web", "help-and-user-manual.html"),
  "utf8",
);
// The bundle the build makes of the module, stamped like every script.
const TAG = /<script src="\/dist\/manual-figures\.js\?v=\d+" defer><\/script>/;

let mod;
const warned = [];

before(async () => {
  /*-
   *  The module asks the server as soon as it loads, as the manual
   *  does. That first ask is answered "not found", as a static copy
   *  would answer it, and must change nothing.
   *
   *  TEST-ONLY global swap: at load the module asks through the global
   *  fetch and warns through the console, with no stand-in for either
   *  to hand it before it loads. Both are put back pristine in the
   *  `finally` below, once the load is done; the cases after it hand
   *  the module a fetch of their own.
   */
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    mod = await import("../src/client/web/dashboard-manual-figures.js");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.fetch = realFetch;
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
  it("loads the bundle that fills its figures, stamped", () => {
    assert.match(MANUAL, TAG);
  });

  it("puts every figure in a span, the shared section's included", () => {
    const shared = MANUAL.slice(
      MANUAL.indexOf("<!-- HELP:inIlGuard:START -->"),
      MANUAL.indexOf("<!-- HELP:inIlGuard:END -->"),
    );
    assert.match(shared, /<span data-figure="ilgDefaultPct">[^<]+<\/span>/);
    assert.doesNotMatch(shared, /\{\{figure:/);
  });

  it("asks nothing of a static copy that changes it, as it loads", () => {
    assert.equal(warned.length, 1);
    assert.match(warned[0], /HTTP 404/);
  });

  it("says why when the server does not answer, and keeps the shipped figures", async () => {
    mountManual();
    const texts = () =>
      [...document.querySelectorAll("[data-figure]")].map(
        (el) => el.textContent,
      );
    const shipped = texts();
    assert.ok(shipped.length > 0);
    const said = [];
    /*-
     *  TEST-ONLY global swap: the module warns through the console and
     *  takes no stand-in for it. Put back pristine in the `finally`
     *  below.
     */
    const realWarn = console.warn;
    console.warn = (...args) => said.push(args.join(" "));
    try {
      await mod.fillManualFigures(async () => ({ ok: false, status: 503 }));
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(texts(), shipped);
    assert.equal(said.length, 1);
    assert.match(said[0], /HTTP 503/);
    assert.match(said[0], /shipped/);
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
    // The Pages build's own page writer, with its own spec.
    const spec = readSpec();
    const manual = spec.pages.find((p) =>
      p.src.endsWith("help-and-user-manual.html"),
    );
    const out = makeTestTempFolder("pages");
    writePage(manual, spec, out);
    const published = fs.readFileSync(
      path.join(out, "help-and-user-manual.html"),
      "utf8",
    );
    assert.ok(!published.includes("manual-figures.js"));
    assert.ok(!published.includes("?v="), "no stamp left for a static host");
    for (const css of [...spec.sharedSheets, manual.css])
      assert.ok(published.includes(`href="${css}"`), `${css} is relative`);
    assert.match(
      published,
      /<span data-figure="ilgDefaultPct">[^<]+<\/span>/,
      "the figures the build wrote stay",
    );
  });
});
