/**
 * @file test/act-icons-files.test.js
 * @description Smoke test ensuring every ACT_ICONS entry in
 * `public/dashboard-helpers.js` resolves to a real file under
 * `public/icons/` that parses as well-formed SVG.  Complements the
 * static XML-validity check in `scripts/lint-svg.js` (which runs at
 * lint time) by pinning the specific icon inventory the dashboard
 * expects — a rename or deletion in the JS registry with no matching
 * file (or vice-versa) fails this test.  See docs/engineering.md
 * § "SVG Assets" for the policy.
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

describe("ACT_ICONS registry ↔ public/icons/ files", () => {
  const inventory = _readActIconsInventory();

  it("has a non-empty registry", () => {
    assert.ok(
      Object.keys(inventory).length > 0,
      "ACT_ICONS parsed as empty — refactor probably broke the file-path shape",
    );
  });

  it("references every file that exists (no orphan files)", () => {
    const onDisk = fs
      .readdirSync(_ICONS_DIR)
      .filter((f) => f.startsWith("act-") && f.endsWith(".svg"));
    const referenced = new Set(
      Object.values(inventory).map((p) => p.replace("icons/", "")),
    );
    const orphans = onDisk.filter((f) => !referenced.has(f));
    assert.deepEqual(
      orphans,
      [],
      "these files exist under public/icons/ but no ACT_ICONS entry points at them: " +
        orphans.join(", "),
    );
  });

  for (const [name, relPath] of Object.entries(inventory)) {
    it(`ACT_ICONS.${name} → ${relPath} exists and parses as SVG`, () => {
      const abs = path.join(__dirname, "..", "public", relPath);
      assert.ok(
        fs.existsSync(abs),
        "missing file for ACT_ICONS." + name + " at " + abs,
      );
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
    });
  }
});
