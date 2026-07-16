#!/usr/bin/env node
/**
 * @file scripts/lint-svg.js
 * @description Strict validator for every `.svg` file under
 * `public/icons/`.  Fails the process (exit code 1) on any of:
 *   1. Malformed XML  — anything the DOMParser flags as an error.
 *   2. Missing root `<svg>` element.
 *   3. Missing `viewBox` on the root.
 *   4. Missing `xmlns` on the root.
 *   5. ANY `id=` attribute anywhere in the file.  LP Ranger icons
 *      forbid ids outright — both rendering shapes (`<img>` for
 *      act-*, inline injection for ui-*) work fine without them,
 *      and forbidding ids removes a latent class of bugs where a
 *      `<use>` reference silently picks the wrong element when the
 *      icon is cloned.  Repeat inlined `<path>` elements instead of
 *      `<defs>` + `<use>`.
 * Wired into `npm run lint` so a bad icon blocks the pre-commit /
 * CI pipeline.  See docs/engineering.md § "SVG Assets" for the
 * policy this enforces.  Runs zero HTTP requests and reads at most
 * O(number of icons) files.
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

/*- Collect every id= attribute in the parsed doc.  LP Ranger's icon
 *  policy forbids ids outright — the two rendering shapes (`<img>`
 *  for act-*, inline injection for ui-*) both work fine without
 *  them, and forbidding them removes a whole class of latent bugs
 *  (id-based `<use>` refs that silently pick the wrong element when
 *  the icon is ever cloned).  Anything that would have needed
 *  defs+use should just inline the path multiple times instead. */
function _findAnyIds(doc) {
  const ids = [];
  function walk(node) {
    if (node.nodeType === 1 && node.getAttribute) {
      const id = node.getAttribute("id");
      if (id) ids.push(id);
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  walk(doc);
  return ids;
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
  const ids = _findAnyIds(doc);
  if (ids.length) {
    _fail(
      file,
      "SVG icons must not carry id= attributes (found: " +
        [...new Set(ids)].join(", ") +
        "); inline repeated shapes instead of using <defs>+<use>",
    );
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
