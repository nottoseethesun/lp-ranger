/**
 * @file test/setting-labels.test.js
 * @description Unit tests for `src/setting-labels.js` and the
 * `GET /api/setting-labels` route handler.  Covers happy path (valid
 * JSON on disk), missing-file fallback, malformed-JSON fallback,
 * `_comment` stripping, non-object-value rejection, empty-label
 * rejection, and the always-200 route contract.  Mirrors the shape
 * of `test/lp-providers.test.js` so future tunable-label files can
 * reuse the same pattern.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "setting-labels.json",
);

let _originalContent = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/setting-labels")];
}

beforeEach(() => {
  if (fs.existsSync(_FILE)) _originalContent = fs.readFileSync(_FILE, "utf8");
  _clearModuleCache();
});

afterEach(() => {
  if (_originalContent !== null) fs.writeFileSync(_FILE, _originalContent);
  _originalContent = null;
  _clearModuleCache();
});

describe("setting-labels.readSettingLabels", () => {
  it("returns a { label, unit } object keyed by config key", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        slippagePct: { label: "Slippage", unit: "%" },
      }),
    );
    const { readSettingLabels } = require("../src/setting-labels");
    const out = readSettingLabels();
    assert.deepEqual(out.slippagePct, { label: "Slippage", unit: "%" });
  });

  it("strips the _comment key", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        _comment: "doc",
        slippagePct: { label: "Slippage", unit: "%" },
      }),
    );
    const { readSettingLabels } = require("../src/setting-labels");
    const out = readSettingLabels();
    assert.equal(out._comment, undefined);
    assert.deepEqual(out.slippagePct, { label: "Slippage", unit: "%" });
  });

  it("skips non-object values, entries without label, and empty labels", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        a: "not an object",
        b: 42,
        c: { unit: "%" },
        d: { label: "   ", unit: "%" },
        e: { label: "Ok", unit: "%" },
      }),
    );
    const { readSettingLabels } = require("../src/setting-labels");
    const out = readSettingLabels();
    assert.equal(out.a, undefined);
    assert.equal(out.b, undefined);
    assert.equal(out.c, undefined);
    assert.equal(out.d, undefined);
    assert.deepEqual(out.e, { label: "Ok", unit: "%" });
  });

  it("defaults unit to empty string when missing", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ x: { label: "X" } }));
    const { readSettingLabels } = require("../src/setting-labels");
    const out = readSettingLabels();
    assert.equal(out.x.label, "X");
    assert.equal(out.x.unit, "");
  });

  it("returns empty map when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readSettingLabels } = require("../src/setting-labels");
    assert.deepEqual(readSettingLabels(), {});
  });

  it("returns empty map when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readSettingLabels } = require("../src/setting-labels");
    assert.deepEqual(readSettingLabels(), {});
  });
});

describe("setting-labels.handleSettingLabels", () => {
  it("returns 200 with the current map", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({ slippagePct: { label: "Slip", unit: "%" } }),
    );
    const { handleSettingLabels } = require("../src/setting-labels");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleSettingLabels({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.deepEqual(gotBody.slippagePct, { label: "Slip", unit: "%" });
  });

  it("returns 200 with empty map when file missing", () => {
    fs.unlinkSync(_FILE);
    const { handleSettingLabels } = require("../src/setting-labels");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleSettingLabels({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.deepEqual(gotBody, {});
  });
});
