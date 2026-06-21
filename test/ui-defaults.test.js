/**
 * @file test/ui-defaults.test.js
 * @description Unit tests for src/ui-defaults.js and the
 * GET /api/ui-defaults route handler.
 *
 * Tests write to the gitignored
 * `app-config/user-configurable/ui-defaults.json` (operator override)
 * rather than the tracked shipped file under
 * `app-defaults-for-user-configurable/` — the loader deep-merges the
 * user file on top of the shipped defaults, so this exercises the
 * exact same path real operators use.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _SHIPPED_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "ui-defaults.json",
);

const _USER_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "user-configurable",
  "ui-defaults.json",
);

/*- The shipped JSON is the source of truth for default values; the
 *  tests read it (NOT a hardcoded copy) so this file never drifts
 *  when an operator updates the shipped defaults. */
const _SHIPPED = JSON.parse(fs.readFileSync(_SHIPPED_FILE, "utf8"));

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/ui-defaults")];
  delete require.cache[require.resolve("../src/load-merged-defaults")];
}

function _writeUser(obj) {
  fs.writeFileSync(_USER_FILE, JSON.stringify(obj));
}

function _clearUser() {
  /*- TOCTOU-safe: a parallel test (24-way concurrency per
   *  package.json) could unlink between exists and unlink.  Treat
   *  ENOENT as success since the post-condition (file absent) holds. */
  try {
    fs.unlinkSync(_USER_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

beforeEach(() => {
  _clearUser();
  _clearModuleCache();
});

afterEach(() => {
  _clearUser();
  _clearModuleCache();
});

describe("ui-defaults.readUiDefaults", () => {
  it("returns soundsEnabled from the user override", () => {
    _writeUser({ soundsEnabled: false });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, false);
  });

  it("returns true when the override sets soundsEnabled to true", () => {
    _writeUser({ soundsEnabled: true });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, true);
  });

  it("falls back to shipped default when no user override exists", () => {
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, _SHIPPED.soundsEnabled);
  });

  it("falls back to shipped default when user override JSON is malformed", () => {
    fs.writeFileSync(_USER_FILE, "{ not valid json");
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, _SHIPPED.soundsEnabled);
  });

  it("ignores non-boolean soundsEnabled override values", () => {
    _writeUser({ soundsEnabled: "yes" });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, _SHIPPED.soundsEnabled);
  });

  it("ignores _comment / _*-prefixed override keys (just doc fields)", () => {
    _writeUser({ _comment: "doc", soundsEnabled: false });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, false);
    assert.equal(out._comment, undefined);
  });

  it("returns privacyModeEnabled from the user override", () => {
    _writeUser({ privacyModeEnabled: true });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.privacyModeEnabled, true);
  });

  it("privacyModeEnabled defaults to shipped value when not overridden", () => {
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.privacyModeEnabled, _SHIPPED.privacyModeEnabled);
  });

  it("returns privacy sub-settings from the user override", () => {
    _writeUser({
      privacyBlurWalletAddresses: false,
      privacyBlurUsdAmounts: false,
      privacyUsdAmountThreshold: 500,
    });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.privacyBlurWalletAddresses, false);
    assert.equal(out.privacyBlurUsdAmounts, false);
    assert.equal(out.privacyUsdAmountThreshold, 500);
  });

  it("privacy defaults to shipped values when keys are absent", () => {
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(
      out.privacyBlurWalletAddresses,
      _SHIPPED.privacyBlurWalletAddresses,
    );
    assert.equal(out.privacyBlurUsdAmounts, _SHIPPED.privacyBlurUsdAmounts);
    assert.equal(
      out.privacyUsdAmountThreshold,
      _SHIPPED.privacyUsdAmountThreshold,
    );
  });

  it("ignores non-boolean privacy toggle overrides", () => {
    _writeUser({
      privacyBlurWalletAddresses: "no",
      privacyBlurUsdAmounts: 0,
    });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(
      out.privacyBlurWalletAddresses,
      _SHIPPED.privacyBlurWalletAddresses,
    );
    assert.equal(out.privacyBlurUsdAmounts, _SHIPPED.privacyBlurUsdAmounts);
  });

  it("clamps privacyUsdAmountThreshold override to the 5-digit input range", () => {
    for (const bad of [-1, 100000, Number.NaN, "99", null]) {
      _writeUser({ privacyUsdAmountThreshold: bad });
      _clearModuleCache();
      const { readUiDefaults } = require("../src/ui-defaults");
      const out = readUiDefaults();
      assert.equal(
        out.privacyUsdAmountThreshold,
        _SHIPPED.privacyUsdAmountThreshold,
      );
    }
  });

  it("floors fractional privacyUsdAmountThreshold override", () => {
    _writeUser({ privacyUsdAmountThreshold: 150.75 });
    const { readUiDefaults } = require("../src/ui-defaults");
    const out = readUiDefaults();
    assert.equal(out.privacyUsdAmountThreshold, 150);
  });
});

describe("ui-defaults.handleUiDefaults", () => {
  it("returns 200 with the merged defaults (user override applied)", () => {
    _writeUser({ soundsEnabled: false });
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

  it("returns 200 with shipped defaults when no user override exists", () => {
    const { handleUiDefaults } = require("../src/ui-defaults");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleUiDefaults({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody.soundsEnabled, _SHIPPED.soundsEnabled);
  });
});
