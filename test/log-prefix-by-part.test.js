"use strict";

/**
 * @file test/log-prefix-by-part.test.js
 * @description Each log line names the part of the app it comes from. A
 *   module in src/bot/ never logs `[server]`, since the headless bot runs
 *   it with no server; a module in src/server/ never logs `[bot]`; and a
 *   module in src/lib/, which both programs load, logs neither, since it
 *   cannot know which one runs it, so it names its own subsystem instead.
 *   Code that moved from one part to another kept the old part's prefix
 *   until 2026-11-24, when 23 bot lines still read `[server]`. Read from
 *   source, as every module logs through `log.info`/`warn`/`error`/`debug`
 *   (src/lib/log.js), whose first argument opens with the prefix.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

/** Every .js file under `dir`, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** A log call whose message opens with `[server]`. */
const SERVER_TAG = /log\.(?:info|warn|error|debug)\(\s*["'`]\[server\]/g;
/** A log call whose message opens with `[bot]`. */
const BOT_TAG = /log\.(?:info|warn|error|debug)\(\s*["'`]\[bot\]/g;
/** A log call whose message opens with either. */
const EITHER_TAG =
  /log\.(?:info|warn|error|debug)\(\s*["'`]\[(?:server|bot)\]/g;

/**
 * `src` with its block comments and whole-line `//` comments blanked to
 * spaces, every line kept, so a usage example in a comment (src/lib/log.js
 * shows `log.info("[bot] …")`) is not taken for a log call.
 * @param {string} src
 * @returns {string}
 */
function blankComments(src) {
  const blank = (c) => c.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);
}

/**
 * Each log call in `file` that `re` matches, as `file:line`.
 * @param {string} file
 * @param {RegExp} re  One of the patterns above.
 * @returns {string[]}
 */
function logsTagged(file, re) {
  const src = blankComments(fs.readFileSync(file, "utf8"));
  return [...src.matchAll(re)].map((m) => {
    const line = src.slice(0, m.index).split("\n").length;
    return `${path.relative(SRC, file)}:${line}`;
  });
}

describe("the prefix each log line opens with", () => {
  it("is never [server] in a bot module", () => {
    const bad = [
      ...jsFiles(path.join(SRC, "bot")),
      path.join(SRC, "bot.js"),
    ].flatMap((f) => logsTagged(f, SERVER_TAG));
    assert.deepEqual(bad, []);
  });

  it("is never [bot] in a server module", () => {
    const bad = [
      ...jsFiles(path.join(SRC, "server")),
      path.join(SRC, "server.js"),
    ].flatMap((f) => logsTagged(f, BOT_TAG));
    assert.deepEqual(bad, []);
  });

  it("is neither in src/lib/, which both programs load", () => {
    const bad = jsFiles(path.join(SRC, "lib")).flatMap((f) =>
      logsTagged(f, EITHER_TAG),
    );
    assert.deepEqual(bad, []);
  });
});
