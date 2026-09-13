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
 * Wired into `npm run lint` and, as the `lint-svg` gate, into
 * `npm run check` — so a bad icon blocks the pre-commit hook and CI
 * alike.  See docs/engineering.md § "SVG Assets" for the policy this
 * enforces.  Runs zero HTTP requests and reads at most O(number of
 * icons) files.
 *
 * `--json` prints the machine-readable result the check report reads,
 * matching every other tool in the check. Parsing the human sentence
 * below instead would make the summary row depend on its wording:
 * rewording the line zeroes the row, and nothing reports that.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");

const _ICONS_DIR = path.join(__dirname, "..", "public", "icons");

/** Format one problem as `<relative path>: <what is wrong>`. */
function _problem(file, msg) {
  return path.relative(process.cwd(), file) + ": " + msg;
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

/**
 * Check one icon against the policy.
 * @param {string} file  Absolute path to a `.svg` file.
 * @returns {string[]}   One entry per violation; empty when the icon is fine.
 */
function _iconProblems(file) {
  const raw = fs.readFileSync(file, "utf8");
  const parseErrors = [];
  const parser = new DOMParser({
    onError: (level, message) => parseErrors.push(level + ": " + message),
  });
  const doc = parser.parseFromString(raw, "image/svg+xml");
  if (parseErrors.length)
    return [_problem(file, "XML parse: " + parseErrors.join("; "))];
  const root = doc.documentElement;
  if (!root || root.tagName !== "svg")
    return [
      _problem(
        file,
        "root element must be <svg>, got <" + (root && root.tagName) + ">",
      ),
    ];
  const problems = [];
  if (!root.getAttribute("xmlns"))
    problems.push(_problem(file, "root <svg> missing xmlns attribute"));
  if (!root.getAttribute("viewBox"))
    problems.push(_problem(file, "root <svg> missing viewBox attribute"));
  const ids = _findAnyIds(doc);
  if (ids.length)
    problems.push(
      _problem(
        file,
        "SVG icons must not carry id= attributes (found: " +
          [...new Set(ids)].join(", ") +
          "); inline repeated shapes instead of using <defs>+<use>",
      ),
    );
  return problems;
}

/**
 * Validate every icon in a directory.
 *
 * Returns the result rather than printing it or exiting, so the CLI
 * below and `test/lint-svg.test.js` can both drive the same code.
 *
 * @param {string} [dir]  Directory to scan.  Defaults to public/icons.
 * @returns {{ok: boolean, files: number, errors: number, problems: string[]}}
 */
function lintSvgIcons(dir = _ICONS_DIR) {
  if (!fs.existsSync(dir))
    return {
      ok: false,
      files: 0,
      errors: 1,
      problems: [dir + " does not exist"],
    };
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .map((f) => path.join(dir, f))
    .sort();
  if (!files.length)
    return {
      ok: false,
      files: 0,
      errors: 1,
      problems: ["no .svg files under " + dir],
    };
  const problems = files.flatMap(_iconProblems);
  return {
    ok: problems.length === 0,
    files: files.length,
    errors: problems.length,
    problems,
  };
}

function main() {
  const result = lintSvgIcons();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    console.log("[lint-svg] " + result.files + " file(s) OK");
  } else {
    for (const p of result.problems) console.error("[lint-svg] " + p);
    console.error(
      "[lint-svg] " +
        result.errors +
        " error(s) across " +
        result.files +
        " file(s)",
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { lintSvgIcons };
