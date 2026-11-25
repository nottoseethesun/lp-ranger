"use strict";

/**
 * @file test/paths-to-the-project-folder.test.js
 * @description A tool or script that finds the project's folder from its
 *   own (`__dirname`) must land on it: the folder holding .env and
 *   app-config/. A file moved one folder deeper, as util/diagnostic/x.js
 *   to util/diagnostic/x/index.js, needs one more `..`, and without it
 *   lands one folder short: a tool that changes directory there finds no
 *   settings and reads no .env.
 *
 *   Two forms are worked out here from their own files: a directory change
 *   (`process.chdir(path.resolve(__dirname, ...))`) under util/, and a
 *   constant naming the project's folder (`ROOT`, `_ROOT`, `REPO`,
 *   `PROJECT`, `= path.resolve/join(__dirname, ...)`) under util/ and
 *   scripts/. Each must be the project's folder.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT = path.join(__dirname, "..");

/** Every .js file under `dir`, test folders left out. */
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "test" && e.name !== "node_modules")
        out.push(...jsFiles(p));
    } else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// The string literals of a call's arguments after `__dirname`.
const LITERALS = String.raw`((?:\s*,\s*(?:"[^"]*"|'[^']*'))*)\s*,?\s*\)`;
const CHDIR = new RegExp(
  String.raw`process\.chdir\(\s*path\.resolve\(\s*__dirname` + LITERALS,
  "g",
);
const ROOT_CONST = new RegExp(
  String.raw`const\s+(\w*(?:ROOT|REPO|PROJECT)\w*)\s*=\s*path\.(?:resolve|join)\(\s*__dirname` +
    LITERALS,
  "g",
);

/**
 * Where each match of `pattern` in `file` lands, worked out from the file's
 * own folder.
 * @param {string} file
 * @param {RegExp} pattern
 * @returns {{line: number, target: string}[]}
 */
function landings(file, pattern) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(pattern)].map((m) => {
    const literals = m[m.length - 1];
    const args = [...literals.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
      (a) => a[1] ?? a[2],
    );
    return {
      line: src.slice(0, m.index).split("\n").length,
      target: path.resolve(path.dirname(file), ...args),
    };
  });
}

/** Each landing of `pattern` under `dirs` that is not the project's folder. */
function strays(dirs, pattern) {
  const out = [];
  let seen = 0;
  for (const dir of dirs)
    for (const file of jsFiles(path.join(PROJECT, dir)))
      for (const l of landings(file, pattern)) {
        seen++;
        if (l.target !== PROJECT)
          out.push(
            `${path.relative(PROJECT, file)}:${l.line} lands on ` +
              `${path.relative(PROJECT, l.target) || "."}`,
          );
      }
  return { out, seen };
}

describe("finding the project's folder from a file's own", () => {
  it("a util tool's directory change lands on the project's folder", () => {
    const { out, seen } = strays(["util"], CHDIR);
    assert.ok(seen >= 4, `only ${seen} directory changes found`);
    assert.deepEqual(out, []);
  });

  it("a constant naming the project's folder is the project's folder", () => {
    const { out, seen } = strays(["util", "scripts"], ROOT_CONST);
    assert.ok(seen >= 10, `only ${seen} project-folder constants found`);
    assert.deepEqual(out, []);
  });

  it("works a target out from its own file, and finds one a level short", () => {
    /*-
     *  Guards the guard: the old line of a tool one folder deep, which
     *  landed on util/.
     */
    const file = path.join(PROJECT, "util", "diagnostic", "x", "index.js");
    const m = [
      ...'process.chdir(path.resolve(__dirname, "..", ".."));'.matchAll(CHDIR),
    ][0];
    const args = [...m[1].matchAll(/"([^"]*)"/g)].map((a) => a[1]);
    assert.equal(
      path.resolve(path.dirname(file), ...args),
      path.join(PROJECT, "util"),
    );
  });
});
