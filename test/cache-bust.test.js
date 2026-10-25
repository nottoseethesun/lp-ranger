"use strict";

/**
 * @file test/cache-bust.test.js
 * @description Every script and stylesheet the app's pages load carries
 *   the build's `?v=` stamp. The server lets a browser keep anything but
 *   HTML for a year, so an unstamped reference would leave a browser on
 *   an old copy after an upgrade. `stampPage` (scripts/cache-bust.js) is
 *   what `npm run build` runs over each page; the pages as committed
 *   carry the last build's stamps, so a reference added without one
 *   fails here.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { stampPage } = require("../scripts/cache-bust");

const PUBLIC = path.join(__dirname, "..", "src", "client", "web");

describe("stampPage", () => {
  it("stamps every script and stylesheet a page loads, relative or absolute", () => {
    const html =
      '<link rel="stylesheet" href="/style.css">' +
      '<link rel="stylesheet" href="fonts.css">' +
      '<script src="/dist/manual-figures.js" defer></script>' +
      '<script src="dist/bundle.js"></script>';
    assert.equal(
      stampPage(html, 7),
      '<link rel="stylesheet" href="/style.css?v=7">' +
        '<link rel="stylesheet" href="fonts.css?v=7">' +
        '<script src="/dist/manual-figures.js?v=7" defer></script>' +
        '<script src="dist/bundle.js?v=7"></script>',
    );
  });

  it("replaces a stamp already there", () => {
    assert.equal(
      stampPage('<link href="/help.css?v=8">', 9),
      '<link href="/help.css?v=9">',
    );
  });

  it("leaves a url naming a host, and a link to a page, alone", () => {
    const html =
      '<script src="https://example.com/a.js"></script>' +
      '<link href="//example.com/b.css">' +
      '<a href="/help-and-user-manual.html">Manual</a>';
    assert.equal(stampPage(html, 7), html);
  });
});

describe("the pages the app serves", () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
  for (const page of pages)
    it(`${page} loads no unstamped script or stylesheet`, () => {
      const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
      const refs = [
        ...html.matchAll(
          /(?:href|src)="(?!https?:|\/\/)([^"#?]+\.(?:css|js)(?:\?[^"]*)?)"/g,
        ),
      ].map((m) => m[1]);
      for (const ref of refs) assert.match(ref, /\?v=\d+$/, `${page}: ${ref}`);
    });
});
