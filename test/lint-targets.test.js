/**
 * @file test/lint-targets.test.js
 * @description
 * Guards the single-source-of-truth invariant for lint/format targets.
 *
 * The bug this exists to prevent already happened three times:
 *   1. `scripts/check.js` spelled out its own ESLint directory list and
 *      omitted `util/`, so 23 files were linted by `npm run lint` but
 *      never by `npm run check` — the gate CI runs.
 *   2. The pre-commit hook ran `lint-staged` with its own `*.js` →
 *      `prettier --write` rule, a second definition of "what gets
 *      formatted" that no gate verified.
 *
 * Both are now driven from `scripts/lint-targets.js`, and the hook runs
 * `npm run lint`. These assertions fail if anything re-introduces a
 * parallel list.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  JS_TARGETS,
  SECURITY_TARGETS,
  SECRET_TARGETS,
  MARKDOWN_TARGETS,
} = require("../scripts/lint-targets");

const ROOT = path.resolve(__dirname, "..");
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pkg = JSON.parse(readRoot("package.json"));

test("JS_TARGETS — is a non-empty list of strings", () => {
  assert.ok(Array.isArray(JS_TARGETS));
  assert.ok(JS_TARGETS.length > 0);
  for (const t of JS_TARGETS) assert.equal(typeof t, "string");
});

test("JS_TARGETS — covers every linted source root", () => {
  /*- Any root ESLint checks must also be Prettier-checked, or the two
   *  gates disagree about what "the code" is. */
  for (const root of [
    "src/**/*.js",
    "test/**/*.js",
    "scripts/**/*.js",
    "util/**/*.js",
    "server.js",
    "bot.js",
    "public/dashboard-*.js",
    "eslint-rules/**/*.js",
  ]) {
    assert.ok(JS_TARGETS.includes(root), `JS_TARGETS must include ${root}`);
  }
});

test("JS_TARGETS — includes util/, the root that CI silently skipped", () => {
  assert.ok(JS_TARGETS.some((t) => t.startsWith("util/")));
});

test("check.js — imports the shared list, does not redeclare it", () => {
  const src = readRoot("scripts/check.js");
  assert.match(src, /require\("\.\/lint-targets"\)/);
  assert.match(src, /\.\.\.JS_TARGETS/);
  assert.match(src, /\.\.\.SECURITY_TARGETS/);
  assert.match(src, /\.\.\.SECRET_TARGETS/);
});

test("check.js — security + secret passes cover util/", () => {
  /*- These two passes each named their own directories and omitted
   *  util/, so the gate CI runs skipped 23 files that the standalone
   *  audit commands checked. */
  assert.ok(SECURITY_TARGETS.includes("util/"));
  assert.ok(SECRET_TARGETS.some((t) => t.startsWith("util/")));
});

test("audit scripts — both delegate to scripts/audit.js", () => {
  assert.match(pkg.scripts["audit:security"], /scripts\/audit\.js --security/);
  assert.match(pkg.scripts["audit:secrets"], /scripts\/audit\.js --secrets/);
});

test("format.js — imports the shared list, does not redeclare it", () => {
  const src = readRoot("scripts/format.js");
  assert.match(src, /require\("\.\/lint-targets"\)/);
  assert.doesNotMatch(src, /"src\/\*\*\/\*\.js"/);
});

test("format scripts — both delegate to scripts/format.js", () => {
  assert.match(pkg.scripts.format, /scripts\/format\.js --write/);
  assert.match(pkg.scripts["format:check"], /scripts\/format\.js --check/);
});

test("lint — runs the JS format check, not only JSON and YAML", () => {
  /*- The original gap: `lint` checked only the JSON and YAML globs,
   *  and no JS at all. */
  assert.match(pkg.scripts.lint, /format:check/);
});

test("lint — ESLint targets include util/", () => {
  assert.match(pkg.scripts.lint, /eslint[^&]*\butil\/\B|eslint[^&]*util\//);
});

test("pre-commit hook — runs the master lint command", () => {
  const hook = readRoot(".husky/pre-commit").trim();
  assert.equal(
    hook,
    "npm run lint",
    "the hook must invoke the one command, not define its own checks",
  );
});

test("lint-staged — is fully removed, config and dependency", () => {
  assert.equal(pkg["lint-staged"], undefined, "config block must be gone");
  assert.equal(
    (pkg.devDependencies || {})["lint-staged"],
    undefined,
    "dependency must be gone once its last usage is removed",
  );
});

test("MARKDOWN_TARGETS — is a non-empty list of strings", () => {
  assert.ok(Array.isArray(MARKDOWN_TARGETS));
  assert.ok(MARKDOWN_TARGETS.length > 0);
  for (const t of MARKDOWN_TARGETS) assert.equal(typeof t, "string");
});

test("MARKDOWN_TARGETS — covers the three docs lint:fix used to skip", () => {
  /*- The drift that prompted centralising this list. */
  for (const f of [
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/engineering.md",
  ]) {
    assert.ok(MARKDOWN_TARGETS.includes(f), `must include ${f}`);
  }
});

test("MARKDOWN_TARGETS — every named file exists", () => {
  /*- A stale entry makes the list look more complete than it is. */
  for (const t of MARKDOWN_TARGETS) {
    if (t.includes("*")) continue;
    assert.ok(fs.existsSync(path.join(ROOT, t)), `missing: ${t}`);
  }
});

test("markdownlint.js — imports the shared list, does not redeclare it", () => {
  const src = readRoot("scripts/markdownlint.js");
  assert.match(src, /require\("\.\/lint-targets"\)/);
  assert.doesNotMatch(src, /"README\.md"/);
});

test("markdown lint — check and fix both delegate to the runner", () => {
  /*- Both passes must read the same list; that is the whole point. */
  assert.match(pkg.scripts.lint, /scripts\/markdownlint\.js/);
  assert.match(pkg.scripts["lint:fix"], /scripts\/markdownlint\.js --fix/);
  assert.doesNotMatch(pkg.scripts.lint, /markdownlint-cli2 README/);
  assert.doesNotMatch(
    pkg.scripts["lint:fix"],
    /markdownlint-cli2 --fix README/,
  );
});

test("check.js — markdown pass uses the shared list too", () => {
  assert.match(readRoot("scripts/check.js"), /\.\.\.MARKDOWN_TARGETS/);
});
