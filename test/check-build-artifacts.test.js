/**
 * @file test/check-build-artifacts.test.js
 * @description Tests for the `scripts/check-build-artifacts.js`
 *   pre-start guard.  Verifies:
 *     - exits 0 when all required artifacts exist
 *     - exits 1 with a clear stderr message when any artifact is missing
 *     - error message names every missing file (not just the first)
 *     - error message includes the "re-download release asset" guidance
 *
 *   Uses child_process to invoke the script with a sandboxed working
 *   directory so we never touch real `public/dist/bundle.js` etc.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(
  __dirname,
  "..",
  "scripts",
  "check-build-artifacts.js",
);

/*- The script resolves its ROOT as `path.resolve(__dirname, "..")`
 *  where `__dirname` is `scripts/`.  We can't relocate the script,
 *  so to test pass/fail we copy it into a sandbox tree that mimics
 *  the same layout (`<sandbox>/scripts/check-build-artifacts.js`
 *  resolves ROOT to `<sandbox>/`) and toggle the four artifact files. */
function setupSandbox(present) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cba-test-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "public", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.copyFileSync(
    SCRIPT,
    path.join(root, "scripts", "check-build-artifacts.js"),
  );
  const all = [
    "public/dist/bundle.js",
    "public/build-info.js",
    "public/disclosure-content.js",
    "src/build-info.json",
  ];
  for (const rel of all) {
    if (present.includes(rel))
      fs.writeFileSync(path.join(root, rel), "/* stub */\n");
  }
  return root;
}

function runGuard(root) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-build-artifacts.js")],
    { encoding: "utf8" },
  );
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("exits 0 when all four required artifacts exist", () => {
  const root = setupSandbox([
    "public/dist/bundle.js",
    "public/build-info.js",
    "public/disclosure-content.js",
    "src/build-info.json",
  ]);
  try {
    const r = runGuard(root);
    assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
    assert.equal(r.stderr, "");
  } finally {
    cleanup(root);
  }
});

test("exits 1 with a clear error when bundle.js is missing", () => {
  const root = setupSandbox([
    "public/build-info.js",
    "public/disclosure-content.js",
    "src/build-info.json",
  ]);
  try {
    const r = runGuard(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing build artifacts/);
    assert.match(r.stderr, /public\/dist\/bundle\.js/);
  } finally {
    cleanup(root);
  }
});

test("lists EVERY missing file, not just the first", () => {
  const root = setupSandbox([]); // all four missing
  try {
    const r = runGuard(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /public\/dist\/bundle\.js/);
    assert.match(r.stderr, /public\/build-info\.js/);
    assert.match(r.stderr, /public\/disclosure-content\.js/);
    assert.match(r.stderr, /src\/build-info\.json/);
  } finally {
    cleanup(root);
  }
});

test("error message points the operator at the release-asset fix", () => {
  const root = setupSandbox([]);
  try {
    const r = runGuard(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Assets section/);
    assert.match(r.stderr, /github\.com\/nottoseethesun\/lp-ranger\/releases/);
    /*- Both common causes (auto-generated source archive + missed
     *  build) must be called out — operators hit each via different
     *  paths and the guidance differs. */
    assert.match(r.stderr, /Source code/);
    assert.match(r.stderr, /npm run build/);
  } finally {
    cleanup(root);
  }
});

test("error message gives copy-pasteable shell commands to back out and re-install", () => {
  const root = setupSandbox([]);
  try {
    const r = runGuard(root);
    assert.equal(r.status, 1);
    /*- The user explicitly asked for `cd ..`, `rm -rf ...`, and
     *  curl-download-verify-extract-install steps — those are the
     *  shell verbs that turn the error message into an actionable
     *  recipe instead of vague prose. */
    assert.match(r.stderr, /cd \.\./);
    assert.match(r.stderr, /rm -rf/);
    assert.match(r.stderr, /curl -LO /);
    assert.match(r.stderr, /sha256sum -c/);
    assert.match(r.stderr, /tar xzf/);
    assert.match(r.stderr, /npm ci/);
    assert.match(r.stderr, /npm start/);
  } finally {
    cleanup(root);
  }
});

test("uses the sandbox's directory name in the `rm -rf` step", () => {
  /*- The script reads its own ROOT as `scripts/..` and prints the
   *  basename in the back-out command.  Pick a distinctive name so the
   *  assertion can't be satisfied by an unrelated word. */
  const root = setupSandbox([]);
  const cwdName = require("node:path").basename(root);
  try {
    const r = runGuard(root);
    assert.match(r.stderr, new RegExp("rm -rf " + cwdName));
  } finally {
    cleanup(root);
  }
});
