/**
 * @file test/ui-defaults.test.js
 * @description Unit tests for src/ui-defaults.js and the
 * GET /api/ui-defaults route handler. Covers the happy path (valid
 * JSON on disk), missing-file fallback, malformed-JSON fallback, and
 * the always-200 route contract.
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
  "static-tunables",
  "ui-defaults.json",
);

let _originalContent = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/ui-defaults")];
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

describe("ui-defaults.readUiDefaults", () => {
  it("returns soundsEnabled from the on-disk JSON", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ soundsEnabled: false }));
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, false);
  });

  it("returns true when the JSON sets soundsEnabled to true", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ soundsEnabled: true }));
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, true);
  });

  it("falls back to built-in default when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, true);
  });

  it("falls back to built-in default when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, true);
  });

  it("ignores non-boolean soundsEnabled values", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ soundsEnabled: "yes" }));
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, true);
  });

  it("ignores the _comment key (just a doc field)", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({ _comment: "doc", soundsEnabled: false }),
    );
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, false);
    assert.equal(out._comment, undefined);
  });
});

describe("ui-defaults.handleUiDefaults", () => {
  it("returns 200 with the current defaults", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ soundsEnabled: false }));
    const { handleUiDefaults } = require("../src/ui-defaults");
    let gotStatus = null;
    let gotBody = null;
    const res = {};
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleUiDefaults({}, res, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.soundsEnabled, false);
  });

  it("returns 200 even when the file is missing", () => {
    fs.unlinkSync(_FILE);
    const { handleUiDefaults } = require("../src/ui-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleUiDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.soundsEnabled, true);
  });
});
