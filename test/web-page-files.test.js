"use strict";

/**
 * @file test/web-page-files.test.js
 * @description Every file the web client's pages and stylesheets load sits
 *   where they name it: each page's own links (stylesheets, the favicon,
 *   images, scripts, other pages) under src/client/web/, and each
 *   stylesheet's url() relative to its own folder. The scripts sit in js/,
 *   the stylesheets in css/ and the images in images/, so a link still
 *   naming an old place fails here. What the build writes (dist/,
 *   css/ui-tokens.css) and the fonts copy-fonts fetches are left out, since
 *   the check runs without a build; the gallery's screenshots come from
 *   docs/images/, which the Pages build puts in the same images/.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "src", "client", "web");
const BUILT = [/^dist\//, /^css\/ui-tokens\.css$/, /^fonts\//];

/** Whether the build or copy-fonts writes `ref`, so git does not hold it. */
const built = (ref) => BUILT.some((re) => re.test(ref));

/**
 * Whether a page's link `ref` (a path under src/client/web/) is a file:
 * there, or, for a gallery screenshot, in docs/images/.
 * @param {string} ref
 * @returns {boolean}
 */
function found(ref) {
  if (fs.existsSync(path.join(WEB, ref))) return true;
  return (
    ref.startsWith("images/") && fs.existsSync(path.join(ROOT, "docs", ref))
  );
}

/**
 * The files a page links to, as paths under src/client/web/: each local
 * href or src naming a file, stamp and leading slash dropped.
 * @param {string} html
 * @returns {string[]}
 */
function pageRefs(html) {
  return [...html.matchAll(/\b(?:href|src)="([^"#]+)"/g)]
    .map((m) => m[1].split("?")[0].replace(/^\//, ""))
    .filter((ref) => !/^(https?:|mailto:|data:)/.test(ref))
    .filter((ref) => /\.[a-z0-9]+$/i.test(ref))
    .filter((ref) => !built(ref));
}

describe("the web client's pages", () => {
  const pages = fs.readdirSync(WEB).filter((f) => f.endsWith(".html"));

  it("are the four pages, alone at the top of the folder", () => {
    assert.deepEqual(pages.sort(), [
      "disclosure.html",
      "help-and-user-manual.html",
      "index.html",
      "screenshot-gallery.html",
    ]);
  });

  for (const page of pages) {
    it(`${page}: every file it loads is where it names it`, () => {
      const refs = pageRefs(fs.readFileSync(path.join(WEB, page), "utf8"));
      assert.ok(refs.length > 0, `${page} names no file`);
      for (const ref of refs) assert.ok(found(ref), `${page}: missing ${ref}`);
    });
  }
});

describe("the web client's stylesheets", () => {
  const sheets = fs
    .readdirSync(path.join(WEB, "css"))
    .filter((f) => f.endsWith(".css") && !built(`css/${f}`));

  for (const sheet of sheets) {
    it(`css/${sheet}: every url() it names is where it names it`, () => {
      const css = fs.readFileSync(path.join(WEB, "css", sheet), "utf8");
      for (const m of css.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
        const ref = m[2].split(/[?#]/)[0];
        if (/^(data:|https?:)/.test(ref)) continue;
        const rel = path
          .relative(WEB, path.resolve(WEB, "css", ref))
          .split(path.sep)
          .join("/");
        if (built(rel)) continue;
        assert.ok(
          fs.existsSync(path.join(WEB, rel)),
          `css/${sheet}: missing ${ref}`,
        );
      }
    });
  }
});
