"use strict";

/**
 * @file test/lint-svg.test.js
 * @description Drives `lintSvgIcons` from `scripts/lint-svg.js` — the
 *   same function the `lint-svg` gate runs in `npm run lint` and
 *   `npm run check`.
 *
 *   Each case points the validator at a temp directory of its own, so
 *   no test can disturb `src/client/web/icons/` (see
 *   docs/claude/CLAUDE-BEST-PRACTICES.md § Test Isolation). The one
 *   case that reads the real directory only reads it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { lintSvgIcons } = require("../scripts/lint-svg");

/** Write one icon into a fresh temp dir and validate it. */
function check(svg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-svg-"));
  try {
    fs.writeFileSync(path.join(dir, "ui-probe.svg"), svg);
    return lintSvgIcons(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<path d="M0 0h10v10H0z"/></svg>';

describe("lintSvgIcons — the shipped icons", () => {
  it("passes, and is actually looking at files", () => {
    const r = lintSvgIcons();
    assert.equal(r.ok, true, r.problems.join("\n"));
    assert.equal(r.errors, 0);
    /*- A validator that found nothing would also report ok. */
    assert.ok(r.files > 10, `only ${r.files} icons scanned`);
  });
});

describe("lintSvgIcons — the policy it enforces", () => {
  it("accepts a well-formed icon", () => {
    const r = check(GOOD);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.files, 1);
  });

  it("rejects an id= attribute anywhere in the file", () => {
    /*- The rule that matters most: an id survives cloning and lets a
     *  `<use>` reference silently pick the wrong element. */
    const r = check(GOOD.replace("<path", '<path id="banned"'));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /must not carry id= attributes.*banned/);
  });

  it("rejects a missing viewBox", () => {
    const r = check(GOOD.replace(' viewBox="0 0 10 10"', ""));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /missing viewBox/);
  });

  it("rejects a missing xmlns", () => {
    const r = check(GOOD.replace(' xmlns="http://www.w3.org/2000/svg"', ""));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /missing xmlns/);
  });

  it("rejects a root element that is not <svg>", () => {
    const r = check('<div xmlns="http://www.w3.org/2000/svg"></div>');
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /root element must be <svg>/);
  });

  it("reports one problem per violation, not one per file", () => {
    /*- The count feeds the check summary's error column, so it has to
     *  mean violations rather than bad files. */
    const r = check('<svg><path id="a"/></svg>');
    assert.ok(r.errors >= 2, `expected several problems, got ${r.errors}`);
    assert.equal(r.errors, r.problems.length);
  });

  it("fails on an empty directory rather than reporting success", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-svg-"));
    try {
      const r = lintSvgIcons(dir);
      assert.equal(r.ok, false);
      assert.match(r.problems[0], /no \.svg files/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a directory that does not exist", () => {
    const r = lintSvgIcons(
      path.join(os.tmpdir(), "lint-svg-nope-" + Date.now()),
    );
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /does not exist/);
  });
});
