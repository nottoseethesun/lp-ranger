/**
 * @file test/bot-config-defaults.test.js
 * @description Unit tests for src/bot-config-defaults.js and the
 * GET /api/bot-config-defaults route handler. Covers the happy path,
 * missing-file fallback, malformed-JSON fallback, clamping of the
 * approvalMultiple integer, and the always-200 route contract.
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
  "bot-config-defaults.json",
);

let _originalContent = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/bot-config-defaults")];
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

describe("bot-config-defaults.readBotConfigDefaults", () => {
  it("returns approvalMultiple from the on-disk JSON", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 50 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 50);
  });

  it("falls back to built-in default when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("falls back to built-in default when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("ignores non-numeric approvalMultiple values", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: "forty" }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("floors fractional approvalMultiple values", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 25.8 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 25);
  });

  it("rejects approvalMultiple < 1 (falls back to built-in)", () => {
    for (const bad of [0, -5]) {
      fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: bad }));
      _clearModuleCache();
      const { readBotConfigDefaults } = require("../src/bot-config-defaults");
      const out = readBotConfigDefaults();
      assert.equal(out.approvalMultiple, 20);
    }
  });

  it("rejects approvalMultiple above the 1_000_000 cap", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 2_000_000 }));
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 20);
  });

  it("ignores the _comment key (just a doc field)", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({ _comment: "doc", approvalMultiple: 30 }),
    );
    const { readBotConfigDefaults } = require("../src/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 30);
    assert.equal(out._comment, undefined);
  });
});

describe("bot-config-defaults.handleBotConfigDefaults", () => {
  it("returns 200 with the current defaults", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ approvalMultiple: 75 }));
    const { handleBotConfigDefaults } = require("../src/bot-config-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleBotConfigDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.approvalMultiple, 75);
  });

  it("returns 200 even when the file is missing", () => {
    fs.unlinkSync(_FILE);
    const { handleBotConfigDefaults } = require("../src/bot-config-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleBotConfigDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.approvalMultiple, 20);
  });
});
