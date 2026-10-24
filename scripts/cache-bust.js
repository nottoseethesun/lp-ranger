/**
 * @file scripts/cache-bust.js
 * @description Stamps the build's time as a `?v=` query on every script
 *   and stylesheet the app's pages load (every `src/client/web/*.html`), and on
 *   the drifting cloud PNGs `9mm-pos-mgr.css` names. The server lets a
 *   browser keep anything but HTML for a year (`serveStatic`,
 *   server.js), so a reference without a fresh stamp would leave a
 *   browser on an old copy after an upgrade.
 */

"use strict";

const { log } = require("../src/lib/log");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join("src", "client", "web");

/*-
 *  A page's own script or stylesheet, stamped or not: `href="/style.css"`,
 *  `src="dist/bundle.js?v=123"`. A url naming a host is not the app's.
 */
const ASSET_REF =
  // eslint-disable-next-line security/detect-unsafe-regex -- Safe: run only on the app's own HTML pages, not user-supplied input
  /(href|src)="(?!https?:|\/\/)([^"?#]+\.(?:css|js))(?:\?v=[^"]*)?"/g;

/**
 * Stamp every script and stylesheet `html` loads with `?v=<v>`,
 * replacing any stamp already there.
 * @param {string} html  A page's HTML.
 * @param {number} v     The stamp.
 * @returns {string}
 */
function stampPage(html, v) {
  return html.replace(ASSET_REF, (_, attr, ref) => `${attr}="${ref}?v=${v}"`);
}

/** Stamp every page and the cloud PNGs with the build's time. */
function main() {
  const v = Date.now();
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
  for (const page of pages) {
    const file = path.join(PUBLIC, page);
    fs.writeFileSync(file, stampPage(fs.readFileSync(file, "utf8"), v));
  }

  const cssPath = path.join(PUBLIC, "9mm-pos-mgr.css");
  let c = fs.readFileSync(cssPath, "utf8");
  for (const layer of ["top", "middle", "bottom"]) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- Safe: `layer` is one of three hard-coded string literals above
    const re = new RegExp(
      'url\\("background-cloud_' + layer + '\\.png(\\?v=[^"]*)?"\\)',
      "g",
    );
    c = c.replace(re, `url("background-cloud_${layer}.png?v=${v}")`);
  }
  fs.writeFileSync(cssPath, c);

  log.info(
    "[npm run build process] [cache-bust] every script and stylesheet in %s, cloud PNGs → v=%d\n",
    pages.join(", "),
    v,
  );
}

if (require.main === module) main();

module.exports = { stampPage };
