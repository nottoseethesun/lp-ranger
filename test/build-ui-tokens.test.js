/**
 * @file test/build-ui-tokens.test.js
 * @description
 * Covers the JSON→CSS bridge for dashboard layout tokens.
 *
 * The info-dialog max height is configured in `ui-defaults.json` but has
 * to reach a stylesheet, and this project forbids inline styles — so
 * `scripts/build-ui-tokens.js` bakes it into a generated
 * `public/ui-tokens.css` at build time. That is three moving parts (the
 * JSON key, the generator, the `var()` reference in the authored CSS)
 * and a break in any one of them fails the same silent way: `var()`
 * with no fallback makes `max-height` invalid at computed-value time,
 * which is `max-height: none` — dialogs quietly grow again and push
 * their Close button off-screen. Nothing visible would report it.
 *
 * These tests check each joint of that chain rather than the generator
 * alone.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readPxToken, renderCss } = require("../scripts/build-ui-tokens");

const ROOT = path.join(__dirname, "..");
const UI_DEFAULTS = path.join(
  ROOT,
  "app-config",
  "app-defaults-for-user-configurable",
  "ui-defaults.json",
);
const INDEX_HTML = path.join(ROOT, "public", "index.html");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/* ---------- the JSON key ---------- */

test("ui-defaults.json ships dialogMaxHeightPx as a positive integer", () => {
  const v = readJson(UI_DEFAULTS).dialogMaxHeightPx;
  assert.equal(typeof v, "number");
  assert.ok(Number.isInteger(v) && v > 0, `not a pixel count: ${v}`);
});

test("the shipped key carries its own explanatory comment", () => {
  /*- Every other tunable in this directory documents itself in-file;
   *  this one especially, because it is the single key here that is NOT
   *  a localStorage-backed preference. */
  assert.ok(readJson(UI_DEFAULTS)._dialogMaxHeightPx_comment);
});

/* ---------- the generator ---------- */

test("readPxToken returns a valid value unchanged", () => {
  assert.equal(readPxToken({ x: 650 }, "x"), 650);
});

test("readPxToken rejects anything that is not a positive integer", () => {
  for (const bad of [undefined, null, 0, -1, 12.5, "650", NaN, Infinity, {}]) {
    assert.throws(
      () => readPxToken({ x: bad }, "x"),
      /positive integer/,
      `${JSON.stringify(bad)} must be rejected, not silently emitted`,
    );
  }
});

test("readPxToken names the offending key so the build error is actionable", () => {
  assert.throws(() => readPxToken({}, "dialogMaxHeightPx"), {
    message: /dialogMaxHeightPx/,
  });
});

test("renderCss emits the custom property with a px unit", () => {
  const css = renderCss({ dialogMaxHeightPx: 650 });
  assert.match(css, /--dialog-max-h:\s*650px;/);
  assert.match(css, /:root\s*\{/);
});

test("renderCss emits no style rules — values only", () => {
  /*- The generated file must never grow into a place where styles are
   *  authored; rules belong beside their neighbours in the real
   *  stylesheets. */
  const css = renderCss({ dialogMaxHeightPx: 650 });
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = withoutComments.match(/[^{}]+\{/g) || [];
  assert.deepEqual(
    selectors.map((s) => s.trim()),
    [":root {"],
    "only :root may appear",
  );
});

test("renderCss warns the reader not to hand-edit", () => {
  assert.match(renderCss({ dialogMaxHeightPx: 1 }), /GENERATED FILE/);
});

/* ---------- the consuming CSS ---------- */

/**
 * Every dialog the cap applies to, and where its vertical overflow goes.
 *
 * A bounded box MUST have somewhere for the overflow to land, or the
 * cap makes things worse than the unbounded dialog it replaces —
 * content spills outside the rounded border, or is clipped outright.
 * Two shapes qualify:
 *
 *   `scrolls: "self"`  — the box carries overflow-y itself.  Used where
 *     content sits directly in the box with nothing to absorb it.
 *   `scrolls: "<selector>"` — the box is a flex column and delegates to
 *     a descendant carrying overflow-y + flex + min-height:0, which is
 *     what keeps the title and dismiss button pinned.
 */
const BOUNDED = [
  {
    file: "9mm-pos-mgr.css",
    rule: "mm-pos-mgr-modal {",
    scrolls: "self",
    note: "variants without a body (wallet-gone, reload shield) need it",
  },
  { file: "style.css", rule: ".modal{", scrolls: "self" },
  {
    file: "9mm-pos-mgr.css",
    rule: "mm-pos-mgr-il-popover-inner {",
    scrolls: "self",
    note: "builds rows straight into the box, no body element",
  },
  {
    file: "9mm-pos-mgr.css",
    rule: "mm-pos-mgr-all-positions-modal {",
    scrolls: "mm-pos-mgr-all-positions-table-wrap {",
    note: "delegates to its table region, so the box must NOT also scroll",
  },
];

/** The body of the rule that starts at `marker` in `file`. */
function ruleBody(file, marker) {
  const css = fs.readFileSync(path.join(ROOT, "public", file), "utf8");
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, `${file}: rule ${marker} not found`);
  return css.slice(start, css.indexOf("}", start));
}

for (const { file, rule, scrolls } of BOUNDED) {
  test(`${file} ${rule} is bounded by the token`, () => {
    assert.match(
      ruleBody(file, rule),
      /max-height:\s*min\(var\(--dialog-max-h\)/,
    );
  });

  test(`${file} ${rule} has somewhere for the overflow to go`, () => {
    if (scrolls === "self") {
      assert.match(
        ruleBody(file, rule),
        /overflow-y:\s*auto/,
        "the box must scroll: nothing inside it can absorb the overflow",
      );
      return;
    }
    /*- Delegating: the box must NOT scroll (that would double up and
     *  detach the pinned header), and the named region must be a
     *  genuine flex scroll area. */
    assert.equal(
      /overflow-y:\s*auto/.test(ruleBody(file, rule)),
      false,
      "a delegating box must not scroll as well",
    );
    assert.match(ruleBody(file, rule), /flex-direction:\s*column/);
    const region = ruleBody(file, scrolls);
    assert.match(region, /overflow-y:\s*auto/);
    assert.match(region, /min-height:\s*0/);
    assert.match(region, /flex:/);
  });
}

test("the token is referenced with NO fallback literal", () => {
  /*- A fallback would be a second copy of the shipped default, which is
   *  exactly what routing it through JSON was meant to avoid. */
  for (const file of ["9mm-pos-mgr.css", "style.css"]) {
    const css = fs.readFileSync(path.join(ROOT, "public", file), "utf8");
    assert.equal(
      /var\(--dialog-max-h\s*,/.test(css),
      false,
      `${file}: var(--dialog-max-h, <fallback>) would duplicate the JSON value`,
    );
  }
});

test("no scrollbar-inside-a-scrollbar in the Pool Details dialog", () => {
  /*- The dialog itself is bounded and scrolls, so the token blocks
   *  inside it must not.  Capping them (at 34vh, say) nests a second
   *  scrollbar: the user scrolls the inner region, hits its end, and
   *  has to notice the outer bar to keep going.
   *
   *  The wrapper element stays (it scopes
   *  `.9mm-pos-mgr-pool-details-block:last-of-type`), but it must carry
   *  no scroll of its own. */
  const css = fs.readFileSync(
    path.join(ROOT, "public", "9mm-pos-mgr.css"),
    "utf8",
  );
  const start = css.indexOf("mm-pos-mgr-pool-details-tokens {");
  if (start === -1) return; // rule removed entirely — nothing to scroll
  const body = css.slice(start, css.indexOf("}", start));
  assert.equal(/overflow-y/.test(body), false, "must not scroll");
  assert.equal(/max-height/.test(body), false, "must not cap its height");
});

test("the Pool Details token wrapper survives, for :last-of-type scoping", () => {
  /*- Deleting the element would move the token blocks up a level and
   *  change which block drops its bottom margin. */
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /class="9mm-pos-mgr-pool-details-tokens"/);
});

test("the Disclosure is deliberately NOT bounded", () => {
  /*- The reader must scroll through the whole text to reach the
   *  accept/decline buttons; a cap with an internal scroll would let
   *  them jump straight to the bottom.  It uses its own class, so it is
   *  exempt by construction — this pins that it stays exempt. */
  const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const box = ruleBody("style.css", ".disclaimer-box{");
  assert.equal(
    /max-height:\s*min\(var\(--dialog-max-h\)/.test(box),
    false,
    "the Disclosure box must not take the dialog cap",
  );
  assert.ok(css.includes(".disclaimer-box{"), "sanity: the rule exists");
});

test("the modal body still absorbs the overflow where one exists", () => {
  /*- The cap only produces body-only scrolling (title and Close pinned)
   *  because the body carries overflow-y:auto and flex:1/min-height:0.
   *  If those were dropped, every dialog would fall back to scrolling as
   *  a whole. */
  const body = ruleBody("9mm-pos-mgr.css", "mm-pos-mgr-modal-body {");
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /flex:\s*1/);
});

/* ---------- the page wiring ---------- */

test("index.html links the generated stylesheet", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(html, /<link rel="stylesheet" href="ui-tokens\.css/);
});

test("the generated file is gitignored, not committed", () => {
  /*- It is build output; a committed copy would drift from the JSON. */
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^public\/ui-tokens\.css$/m);
});

test("the build runs the generator before bundling", () => {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const build = pkg.scripts.build;
  assert.match(build, /build-ui-tokens\.js/);
  assert.ok(
    build.indexOf("build-ui-tokens.js") < build.indexOf("cache-bust.js"),
    "the file must exist before cache-bust stamps its link",
  );
});

test("prelint generates the stylesheet so lint sees it in CI too", () => {
  /*- `stylelint public/*.css` only lints files that exist.  Without
   *  this, the generated file would be linted on a developer's machine
   *  (where a build has run) and silently skipped in CI, which is the
   *  asymmetry that lets a generator start emitting invalid CSS
   *  unnoticed. */
  const pkg = readJson(path.join(ROOT, "package.json"));
  assert.match(pkg.scripts.prelint, /build-ui-tokens\.js/);
});

test("cache-bust stamps the generated stylesheet", () => {
  /*- Regenerated on every build, so a browser holding the old copy
   *  would keep a stale --dialog-max-h after an operator edits the
   *  JSON. */
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "cache-bust.js"),
    "utf8",
  );
  assert.match(src, /ui-tokens\.css\?v=/);
});
