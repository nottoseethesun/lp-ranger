/**
 * @file test/helpers/index-html.js
 * @description The dashboard's `public/index.html`, parsed into a DOM
 *   document, for tests that inspect its markup or clone its templates.
 *
 *   Uses the DOM implementation already in scope, so a caller registers
 *   jsdom (`global-jsdom/register`) before calling it.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INDEX_HTML = path.join(__dirname, "..", "..", "public", "index.html");

/**
 * Parse `public/index.html` into a new document.
 *
 * @returns {Document}  Read from disk on every call, so each caller gets
 *   its own copy.
 */
function indexHtmlDocument() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  return new window.DOMParser().parseFromString(html, "text/html");
}

module.exports = { indexHtmlDocument };
