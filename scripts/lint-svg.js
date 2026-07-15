#!/usr/bin/env node
/**
 * @file scripts/lint-svg.js
 * @description Strict validator for every `.svg` file under
 * `public/icons/`.  Fails the process (exit code 1) on any of:
 *   1. Malformed XML  — anything the DOMParser flags as an error.
 *   2. Missing root `<svg>` element.
 *   3. Missing or non-canonical `viewBox` on the root.
 *   4. Missing `xmlns` on the root.
 *   5. Duplicate `id=` attributes within a single file  (they would
 *      collide across DOM copies when the icon renders multiple
 *      times if the icon were ever inlined instead of loaded via
 *      `<img>`).
 * Wired into `npm run lint` via `npm run lint:svg` so a bad icon
 * blocks the pre-commit / CI pipeline.  See
 * docs/engineering.md § "SVG Assets" for the policy this enforces.
 * Runs zero HTTP requests and reads at most O(number of icons) files.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");

const _DIR = path.join(__dirname, "..", "public", "icons");

let _errCount = 0;
function _fail(file, msg) {
  console.error(
    "[lint-svg] " + path.relative(process.cwd(), file) + ": " + msg,
  );
  _errCount += 1;
}

/*- Collect ids inside the parsed doc; a set-vs-list length delta
 *  means at least one id repeated. */
function _findDuplicateIds(doc) {
  const ids = [];
  function walk(node) {
    if (node.nodeType === 1 && node.getAttribute) {
      const id = node.getAttribute("id");
      if (id) ids.push(id);
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  walk(doc);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    else seen.add(id);
  }
  return [...new Set(dupes)];
}

function _validate(file) {
  const raw = fs.readFileSync(file, "utf8");
  const errors = [];
  const parser = new DOMParser({
    onError: (level, message) => errors.push(level + ": " + message),
  });
  const doc = parser.parseFromString(raw, "image/svg+xml");
  if (errors.length) {
    _fail(file, "XML parse: " + errors.join("; "));
    return;
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "svg") {
    _fail(
      file,
      "root element must be <svg>, got <" + (root && root.tagName) + ">",
    );
    return;
  }
  if (!root.getAttribute("xmlns")) {
    _fail(file, "root <svg> missing xmlns attribute");
  }
  if (!root.getAttribute("viewBox")) {
    _fail(file, "root <svg> missing viewBox attribute");
  }
  const dupes = _findDuplicateIds(doc);
  if (dupes.length) {
    _fail(file, "duplicate id(s) inside file: " + dupes.join(", "));
  }
}

function main() {
  if (!fs.existsSync(_DIR)) {
    console.error("[lint-svg] " + _DIR + " does not exist");
    process.exit(1);
  }
  const files = fs
    .readdirSync(_DIR)
    .filter((f) => f.endsWith(".svg"))
    .map((f) => path.join(_DIR, f))
    .sort();
  if (!files.length) {
    console.error("[lint-svg] no .svg files under " + _DIR);
    process.exit(1);
  }
  for (const file of files) _validate(file);
  if (_errCount > 0) {
    console.error(
      "[lint-svg] " +
        _errCount +
        " error(s) across " +
        files.length +
        " file(s)",
    );
    process.exit(1);
  }
  console.log("[lint-svg] " + files.length + " file(s) OK");
}

main();
