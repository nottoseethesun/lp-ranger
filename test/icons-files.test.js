/**
 * @file test/icons-files.test.js
 * @description Smoke test ensuring every icon reference in the
 * dashboard resolves to a real file under `public/icons/` that
 * parses as well-formed SVG.  Complements the static XML-validity
 * check in `scripts/lint-svg.js` (which runs at lint time and
 * validates every file in the directory) by pinning the specific
 * icon inventory the dashboard actually expects — a rename or
 * deletion on either side surfaces here.
 *
 * Covers both:
 *   * Activity-Log icons — `ACT_ICONS` map in
 *     `public/dashboard-helpers.js` (loaded via `<img>` per
 *     docs/engineering.md § "SVG Assets").
 *   * Header / wallet-strip / modal icons — `data-svg="…"`
 *     placeholder attributes in `public/index.html` (inlined at
 *     build time by `scripts/inline-svgs.js` into
 *     `public/dist/index.html`).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");

const _ICONS_DIR = path.join(__dirname, "..", "public", "icons");

/*- Pluck the ACT_ICONS constant out of the ES-module dashboard file
 *  via a targeted regex.  Avoids booting a browser/JSDOM just to
 *  `import` from an .mjs file.  The JS file is the source of truth
 *  — matching what would ship in bundle.js. */
function _readActIconsInventory() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "public", "dashboard-helpers.js"),
    "utf8",
  );
  const match = src.match(/export const ACT_ICONS = \{([^}]+)\}/);
  if (!match)
    throw new Error("ACT_ICONS block not found in dashboard-helpers.js");
  const inventory = {};
  const entryRe = /(\w+):\s*"(icons\/[^"]+)"/g;
  let m;
  while ((m = entryRe.exec(match[1])) !== null) inventory[m[1]] = m[2];
  return inventory;
}

/*- Enumerate every `data-svg="icons/…"` placeholder in index.html.
 *  Same regex-parse rationale as _readActIconsInventory — we don't
 *  want to spin up JSDOM just to read attributes. */
function _readUiIconInventory() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "public", "index.html"),
    "utf8",
  );
  const set = new Set();
  const re = /data-svg="(icons\/[^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) set.add(m[1]);
  return [...set];
}

function _assertFileParsesAsSvg(relPath) {
  const abs = path.join(__dirname, "..", "public", relPath);
  assert.ok(fs.existsSync(abs), "missing file at " + abs);
  const errors = [];
  const parser = new DOMParser({
    onError: (level, message) => errors.push(level + ": " + message),
  });
  const doc = parser.parseFromString(
    fs.readFileSync(abs, "utf8"),
    "image/svg+xml",
  );
  assert.deepEqual(errors, [], "XML parse errors: " + errors.join("; "));
  assert.equal(
    doc.documentElement.tagName,
    "svg",
    "root element must be <svg>",
  );
}

describe("Icon registries ↔ public/icons/ files", () => {
  const actInventory = _readActIconsInventory();
  const uiInventory = _readUiIconInventory();

  it("ACT_ICONS registry parses as non-empty", () => {
    assert.ok(
      Object.keys(actInventory).length > 0,
      "ACT_ICONS parsed as empty — refactor probably broke the file-path shape",
    );
  });

  it("index.html data-svg placeholder set parses as non-empty", () => {
    assert.ok(
      uiInventory.length > 0,
      "no data-svg placeholders found in index.html — refactor probably broke the attribute shape",
    );
  });

  it("every file under public/icons/ is referenced by ACT_ICONS OR index.html", () => {
    const onDisk = fs.readdirSync(_ICONS_DIR).filter((f) => f.endsWith(".svg"));
    const referenced = new Set([
      ...Object.values(actInventory).map((p) => p.replace("icons/", "")),
      ...uiInventory.map((p) => p.replace("icons/", "")),
    ]);
    const orphans = onDisk.filter((f) => !referenced.has(f));
    assert.deepEqual(
      orphans,
      [],
      "these files exist under public/icons/ but nothing references them: " +
        orphans.join(", "),
    );
  });

  for (const [name, relPath] of Object.entries(actInventory)) {
    it(`ACT_ICONS.${name} → ${relPath} exists and parses as SVG`, () => {
      _assertFileParsesAsSvg(relPath);
    });
  }

  for (const relPath of uiInventory) {
    it(`data-svg="${relPath}" (index.html) exists and parses as SVG`, () => {
      _assertFileParsesAsSvg(relPath);
    });
  }
});
