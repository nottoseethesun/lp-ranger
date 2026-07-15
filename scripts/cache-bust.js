/**
 * @file scripts/cache-bust.js
 * @description Stamp cache-bust query strings on bundle.js, style.css,
 * and 9mm-pos-mgr.css references in public/index.html, plus the drifting
 * cloud PNGs referenced inside 9mm-pos-mgr.css.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const v = Date.now();

const htmlPath = "public/index.html";
let h = fs.readFileSync(htmlPath, "utf8");
h = h.replace(/bundle\.js\?v=[^"']*/g, "bundle.js?v=" + v);
// eslint-disable-next-line security/detect-unsafe-regex -- Safe: input is local index.html, not user-supplied
h = h.replace(/style\.css(\?v=[^"']*)?"/, "style.css?v=" + v + '"');
// eslint-disable-next-line security/detect-unsafe-regex -- Safe: input is local index.html, not user-supplied
h = h.replace(/9mm-pos-mgr\.css(\?v=[^"']*)?"/, "9mm-pos-mgr.css?v=" + v + '"');
fs.writeFileSync(htmlPath, h);

const cssPath = "public/9mm-pos-mgr.css";
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
  "[npm run build process][cache-bust] bundle.js, style.css, 9mm-pos-mgr.css, cloud PNGs → v=%d\n",
  v,
);
