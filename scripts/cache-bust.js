/**
 * @file scripts/cache-bust.js
 * @description Stamp cache-bust query strings on bundle.js, style.css,
 * and 9mm-pos-mgr.css references in public/index.html.
 */

"use strict";

const fs = require("fs");
const p = "public/index.html";
const v = Date.now();
let h = fs.readFileSync(p, "utf8");
h = h.replace(/bundle\.js\?v=[^"']*/g, "bundle.js?v=" + v);
h = h.replace(/style\.css(\?v=[^"']*)?"/, "style.css?v=" + v + '"');
h = h.replace(/9mm-pos-mgr\.css(\?v=[^"']*)?"/, "9mm-pos-mgr.css?v=" + v + '"');
fs.writeFileSync(p, h);
console.log("[cache-bust] bundle.js, style.css, 9mm-pos-mgr.css → v=%d", v);
