/**
 * @file test/build-and-start-help.test.js
 * @description
 * `npm run build-and-start -- --help` answers, and does nothing else.
 *
 * It used to run the whole build first. npm appends everything after
 * `--` to the end of the script line, so `npm run build && node
 * server.js` became `npm run build && node server.js --help`: the build
 * ran to completion — rewriting the bundle, the generated content and
 * the cache-bust stamps — and only then did the server print its help.
 * Asking what a command does should not perform the command.
 *
 * A flag that has to be seen before the first step needs something in
 * front of both steps, which is `scripts/build-and-start.js`.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-and-start.js");

/** Run the wrapper with the given flags, capturing what it printed. */
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("build-and-start --help answers without doing the work", () => {
  it("prints its own help and exits cleanly", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0, "help is a success, not an error");
    const out = r.stdout + r.stderr;
    assert.match(out, /Build the dashboard, then start the server/);
    assert.match(out, /npm run build-and-start \[-- options\]/);
  });

  it("answers to -h as well", () => {
    const out = run(["-h"]).stdout + run(["-h"]).stderr;
    assert.match(out, /Build the dashboard, then start the server/);
  });

  it("does not run the build", () => {
    /*- The bundle's mtime is the evidence. A build rewrites it, along
     *  with the cache-bust stamps that invalidate every browser's copy
     *  of the dashboard — a heavy side effect for a question. */
    const bundle = path.join(ROOT, "public", "dist", "bundle.js");
    if (!fs.existsSync(bundle)) return; // nothing built yet; nothing to protect
    const before = fs.statSync(bundle).mtimeMs;
    run(["--help"]);
    assert.equal(
      fs.statSync(bundle).mtimeMs,
      before,
      "--help rebuilt the bundle",
    );
  });

  it("does not start a server", () => {
    /*- The server's first line on a real run. Its absence is the whole
     *  point: help starts nothing, so it must not announce a start. */
    const out = run(["--help"]).stdout + run(["--help"]).stderr;
    assert.doesNotMatch(out, /Started\./, "help announced a server start");
  });

  it("names the help of each command it runs, ready to paste", () => {
    /*- The operator's next question after "what is this" is "what can I
     *  pass it". The flag list itself is NOT copied here — it lives with
     *  the server, and a copy would drift the first time a flag moved. */
    const out = run(["--help"]).stdout + run(["--help"]).stderr;
    assert.match(out, /npm start -- --help/, "the server's help");
    assert.match(out, /npm run build\b/, "the build it runs");
    assert.match(out, /docs\/npm-project-commands\.md/, "the full reference");
  });
});

describe("the wrapper is what package.json runs", () => {
  it("replaced the two chained commands", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    const s = pkg.scripts["build-and-start"];
    assert.match(s, /scripts\/build-and-start\.js/);
    assert.doesNotMatch(
      s,
      /&&/,
      "a chained script cannot see a flag before its first command runs",
    );
  });
});
