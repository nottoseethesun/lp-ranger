"use strict";

/**
 * @file test/tests-leave-shipped-files-alone.test.js
 * @description No test writes or removes a file in the tracked shipped
 *   settings folder (`app-config/app-defaults-for-user-configurable/`).
 *
 *   Every test process reads that folder while the suite runs, so a test
 *   that rewrote a file there could fail an unrelated one, and a run
 *   stopped part way would leave the file changed for the next
 *   `npm start`. A test that has to change a shipped file changes a copy
 *   (test/helpers/shipped-defaults-copy.js).
 *
 *   Read from each test file's source: a path built from the repo
 *   (`__dirname` or `process.cwd()`) to the folder, as a constant or in
 *   place, handed to a call that writes or removes a file. A path built
 *   inside a temp folder, as a test's own copy of an install is, is not
 *   the tracked folder.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FOLDER = "app-defaults-for-user-configurable";

/*-
 *  Calls that change a file, and which of their arguments is the file
 *  changed: the first, but for a copy, whose destination is the second,
 *  and a rename, which changes both.
 */
const CHANGED_ARGS = Object.freeze({
  writeFileSync: [0],
  appendFileSync: [0],
  truncateSync: [0],
  unlinkSync: [0],
  rmSync: [0],
  mkdirSync: [0],
  renameSync: [0, 1],
  copyFileSync: [1],
  cpSync: [1],
});

/**
 * The text of a call's arguments, from just after its opening
 * parenthesis to its closing one, split at the commas between them.
 * @param {string} src
 * @param {number} open  Index of the opening parenthesis.
 * @returns {string[]}
 */
function _args(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i).trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** Whether an expression is a path built from the repo to the folder. */
const _isRepoPathToFolder = (expr) =>
  /^path\.join\(\s*(?:__dirname|process\.cwd\(\))/.test(expr) &&
  expr.includes(FOLDER);

/**
 * The names a source binds to a repo path to the folder.
 * @param {string} src
 * @returns {Set<string>}
 */
function _folderPathNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*path\.join\(/g)) {
    const open = m.index + m[0].length - 1;
    const expr = `path.join(${_args(src, open).join(", ")})`;
    if (_isRepoPathToFolder(expr)) names.add(m[1]);
  }
  return names;
}

/**
 * Every call in a source that changes a file in the tracked folder.
 * @param {string} src
 * @returns {string[]} Each such call's text, for the message.
 */
function shippedFileWrites(src) {
  const names = _folderPathNames(src);
  const named = (arg) =>
    _isRepoPathToFolder(arg) ||
    [...names].some(
      (n) => arg === n || new RegExp(`^path\\.join\\(\\s*${n}\\b`).test(arg),
    );
  const found = [];
  for (const m of src.matchAll(/\bfs\.(\w+)\(/g)) {
    const which = CHANGED_ARGS[m[1]];
    if (which === undefined) continue;
    const args = _args(src, m.index + m[0].length - 1);
    if (which.some((i) => args[i] !== undefined && named(args[i])))
      found.push(`fs.${m[1]}(${args.join(", ")})`);
  }
  return found;
}

/** Every test source: test/, its helpers and its subfolders, and util/test/. */
function _testSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "report-artifacts") walk(p);
      } else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "test"));
  walk(path.join(ROOT, "util", "test"));
  return out;
}

describe("tests and the shipped settings folder", () => {
  it("finds the forms a write to the folder takes", () => {
    const bad = [
      `const F = path.join(__dirname, "..", "app-config", "${FOLDER}", "x.json");
       fs.writeFileSync(F, "{}");`,
      `const CFG = path.join(process.cwd(), "app-config", "${FOLDER}", "x.json");
       fs.unlinkSync(CFG);`,
      `fs.rmSync(path.join(__dirname, "..", "app-config", "${FOLDER}"), { recursive: true });`,
      `const D = path.join(__dirname, "..", "app-config", "${FOLDER}");
       fs.copyFileSync("/tmp/a.json", path.join(D, "x.json"));`,
      `fs.writeFileSync(path.join(__dirname, "../app-config/${FOLDER}/x.json"), "");`,
    ];
    for (const src of bad) assert.equal(shippedFileWrites(src).length, 1, src);
  });

  it("passes what only reads the folder, or writes a temp copy of it", () => {
    const fine = [
      `const S = path.join(__dirname, "..", "app-config", "${FOLDER}");
       fs.cpSync(S, dir, { recursive: true });`,
      `const F = path.join(d, "app-config/${FOLDER}/chains.json");
       fs.writeFileSync(F, "SHIPPED");`,
      `const F = path.join(__dirname, "..", "app-config", "${FOLDER}", "x.json");
       fs.readFileSync(F, "utf8");`,
    ];
    for (const src of fine) assert.deepEqual(shippedFileWrites(src), [], src);
  });

  it("is never written or removed by a test", () => {
    const found = [];
    for (const file of _testSources()) {
      if (file === __filename) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const call of shippedFileWrites(src))
        found.push(`${path.relative(ROOT, file)}: ${call}`);
    }
    assert.deepEqual(found, [], found.join("\n"));
  });
});
