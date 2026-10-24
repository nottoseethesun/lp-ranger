"use strict";

/**
 * @file test/plain-object.test.js
 * @description `isPlainObject` (src/lib/plain-object.js): whether a value is
 *   something JSON writes with braces. Records read from `app-data/` and
 *   answers sent to the dashboard are checked this way before their
 *   fields are read, so the dashboard bundles the module too, and it
 *   must stay free of imports.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isPlainObject } = require("../src/lib/plain-object");

describe("isPlainObject", () => {
  it("is true for an object, whatever it holds", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
  });

  it("is false for null, a list and every value that is not an object", () => {
    for (const v of [null, undefined, [], [1], 0, 1n, "x", true, () => {}])
      assert.equal(isPlainObject(v), false, String(v));
  });

  it("imports nothing", () => {
    /*-
     *  The dashboard bundle imports this file, so a single `require` of
     *  anything Node-only would break the build, and the failure would
     *  show as a broken dashboard, not a failing test.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "plain-object.js"),
      "utf8",
    );
    assert.deepEqual(src.match(/\brequire\s*\(/g) || [], []);
    assert.deepEqual(src.match(/^\s*import\s/gm) || [], []);
  });
});
