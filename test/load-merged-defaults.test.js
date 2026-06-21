/**
 * @file test/load-merged-defaults.test.js
 * @description Tests for src/load-merged-defaults.js — the two-layer
 * shipped-defaults + user-override merge helper.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  loadMergedDefaults,
  DEFAULTS_DIR,
  USER_DIR,
} = require("../src/load-merged-defaults");

const _NAME = "test-load-merged-defaults-fixture.json";
const _DEF = path.join(DEFAULTS_DIR, _NAME);
const _USR = path.join(USER_DIR, _NAME);

function _writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj));
}

function _safeUnlink(p) {
  /*- TOCTOU-safe: parallel test files (24-way concurrency per
   *  package.json) could unlink between exists and unlink.  Treat
   *  ENOENT as success since the post-condition (file absent) holds. */
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

beforeEach(() => {
  if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
});

afterEach(() => {
  _safeUnlink(_DEF);
  _safeUnlink(_USR);
});

describe("loadMergedDefaults", () => {
  it("returns shipped defaults when no user override exists", () => {
    _writeJson(_DEF, { a: 1, b: { c: 2 } });
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out, { a: 1, b: { c: 2 } });
  });

  it("deep-merges user values on top of defaults", () => {
    _writeJson(_DEF, { a: 1, b: { c: 2, d: 3 }, e: 4 });
    _writeJson(_USR, { b: { c: 99 }, e: 5 });
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out, { a: 1, b: { c: 99, d: 3 }, e: 5 });
  });

  it("user value wins for primitive keys", () => {
    _writeJson(_DEF, { x: "default" });
    _writeJson(_USR, { x: "override" });
    const out = loadMergedDefaults(_NAME);
    assert.equal(out.x, "override");
  });

  it("arrays REPLACE rather than merge", () => {
    _writeJson(_DEF, { list: [1, 2, 3, 4] });
    _writeJson(_USR, { list: [9, 8] });
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out.list, [9, 8]);
  });

  it("user can add new keys not in defaults", () => {
    _writeJson(_DEF, { a: 1 });
    _writeJson(_USR, { newKey: { nested: "value" } });
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out, { a: 1, newKey: { nested: "value" } });
  });

  it("user value of null overrides a defaulted object (explicit null)", () => {
    _writeJson(_DEF, { a: { b: 1 } });
    _writeJson(_USR, { a: null });
    const out = loadMergedDefaults(_NAME);
    assert.equal(out.a, null);
  });

  it("throws when shipped defaults file is missing", () => {
    _safeUnlink(_DEF);
    assert.throws(() => loadMergedDefaults(_NAME), /Cannot read shipped/);
  });

  it("throws when shipped defaults JSON is malformed", () => {
    fs.writeFileSync(_DEF, "{ not valid json");
    assert.throws(() => loadMergedDefaults(_NAME), /Malformed shipped/);
  });

  it("falls back to defaults when user override JSON is malformed", () => {
    _writeJson(_DEF, { a: 1, b: 2 });
    fs.writeFileSync(_USR, "{ not valid json");
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out, { a: 1, b: 2 });
  });

  it("nested deep-merge: 3 levels", () => {
    _writeJson(_DEF, {
      l1: { l2: { l3a: 1, l3b: 2, l3c: 3 }, sibling: "keep" },
    });
    _writeJson(_USR, { l1: { l2: { l3b: 99 } } });
    const out = loadMergedDefaults(_NAME);
    assert.deepEqual(out, {
      l1: { l2: { l3a: 1, l3b: 99, l3c: 3 }, sibling: "keep" },
    });
  });

  it("user-only file (no matching default) still throws because defaults are required", () => {
    _safeUnlink(_DEF);
    _writeJson(_USR, { x: 1 });
    assert.throws(() => loadMergedDefaults(_NAME), /Cannot read shipped/);
  });
});
