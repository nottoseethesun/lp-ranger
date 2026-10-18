"use strict";

/**
 * @file test/ui-defaults.test.js
 * @description The dashboard settings the server sends (src/ui-defaults.js)
 *   and `GET /api/ui-defaults`, which answers with them.
 *
 *   They are ui-defaults_non-layout_for-server-up-scenario.json with an
 *   operator's copy on top, each value held to its rule: true or false for
 *   an on/off setting, the timer rule for one the page turns into a timer
 *   delay, and its range in setting-bounds.json for any other. Read at
 *   startup, strictly, a value outside its rule stops the app; any other
 *   read keeps the shipped value in its place.
 *
 *   The operator's copy is written to a temporary directory of this
 *   file's own, never to app-config/user-configurable/. The loader reads
 *   `LP_RANGER_USER_CONFIG_DIR` at module load, so it is set before
 *   anything under `src/` is required.
 */

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ui-defaults-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const _FILE = "ui-defaults_non-layout_for-server-up-scenario.json";
const {
  loadShippedDefaults,
  _resetMemoForTests: resetLoaderMemo,
} = require("../src/load-merged-defaults");
const {
  readUiDefaults,
  readUiDefaultsStrict,
  handleUiDefaults,
  _resetMemoForTests,
} = require("../src/ui-defaults");

const SHIPPED = loadShippedDefaults(_FILE);

/**
 * Write the operator's copy of the file, as raw text or an object. The
 * loader keeps each file it has read, so it is told to read again.
 */
function writeOverride(body) {
  fs.writeFileSync(
    path.join(_USER_DIR, _FILE),
    typeof body === "string" ? body : JSON.stringify(body),
  );
  resetLoaderMemo();
}

before(() => {
  for (const key of Object.keys(SHIPPED))
    assert.ok(!key.startsWith("_"), `${key} is a note, not a setting`);
});

beforeEach(() => {
  fs.rmSync(path.join(_USER_DIR, _FILE), { force: true });
  resetLoaderMemo();
  _resetMemoForTests();
});

describe("readUiDefaults", () => {
  it("is every shipped setting when the operator has written none", () => {
    assert.deepEqual({ ...readUiDefaults() }, SHIPPED);
  });

  it("applies each operator value that keeps its rule", () => {
    /*-
     *  One setting of each kind, each moved off its shipped value: an
     *  on/off, a timer and a ranged one.
     */
    writeOverride({
      soundsEnabled: !SHIPPED.soundsEnabled,
      dashboardPollIntervalMs: SHIPPED.dashboardPollIntervalMs + 1000,
      throttleNearLimitPct: SHIPPED.throttleNearLimitPct - 20,
    });
    const out = readUiDefaults();
    assert.equal(out.soundsEnabled, !SHIPPED.soundsEnabled);
    assert.equal(
      out.dashboardPollIntervalMs,
      SHIPPED.dashboardPollIntervalMs + 1000,
    );
    assert.equal(out.throttleNearLimitPct, SHIPPED.throttleNearLimitPct - 20);
  });

  it("keeps the shipped value for a setting written outside its rule", () => {
    writeOverride({
      soundsEnabled: "yes",
      copyFeedbackMs: 0,
      throttleNearLimitPct: 150,
      activityLogMaxEntries: 99.5,
    });
    const out = readUiDefaults();
    for (const key of [
      "soundsEnabled",
      "copyFeedbackMs",
      "throttleNearLimitPct",
      "activityLogMaxEntries",
    ])
      assert.equal(out[key], SHIPPED[key], key);
  });

  it("leaves the shipped values standing when the file cannot be parsed", () => {
    writeOverride("{ not json");
    assert.deepEqual({ ...readUiDefaults() }, SHIPPED);
  });
});

describe("readUiDefaultsStrict", () => {
  it("refuses every setting written outside its rule, naming the file and each one", () => {
    writeOverride({
      soundsEnabled: "yes",
      dashboardPollIntervalMs: 100,
      throttleNearLimitPct: 150,
    });
    assert.throws(
      () => readUiDefaultsStrict(),
      (err) => {
        assert.equal(err.badSettingValue, true);
        assert.match(err.message, new RegExp(`user-configurable/${_FILE}`));
        assert.match(err.message, /soundsEnabled must be true or false/);
        assert.match(err.message, /dashboardPollIntervalMs/);
        assert.match(err.message, /throttleNearLimitPct must be .*; it is 150/);
        return true;
      },
    );
  });

  it("accepts every shipped value written back as an override", () => {
    /*-
     *  Every setting goes through its rule here, so a setting shipped
     *  without one would throw rather than pass unchecked.
     */
    writeOverride(SHIPPED);
    assert.deepEqual({ ...readUiDefaultsStrict() }, SHIPPED);
  });

  it("holds the stale-figures check to ten milliseconds through a second", () => {
    for (const ms of [9, 1001, 50.5]) {
      writeOverride({ staleDataCheckIntervalMs: ms });
      _resetMemoForTests();
      assert.throws(
        () => readUiDefaultsStrict(),
        /staleDataCheckIntervalMs/,
        `${ms} is refused`,
      );
    }
    for (const ms of [10, 1000]) {
      writeOverride({ staleDataCheckIntervalMs: ms });
      _resetMemoForTests();
      assert.equal(readUiDefaultsStrict().staleDataCheckIntervalMs, ms);
    }
  });

  it("is the answer every later read returns, an edit since included", () => {
    writeOverride({ throttleNearLimitPct: 50 });
    readUiDefaultsStrict();
    writeOverride({ throttleNearLimitPct: 60 });
    assert.equal(readUiDefaults().throttleNearLimitPct, 50);
  });
});

describe("GET /api/ui-defaults", () => {
  it("answers 200 with the settings in force", () => {
    writeOverride({ privacyUsdAmountThreshold: 500 });
    let status = null;
    let body = null;
    handleUiDefaults({}, {}, (_res, s, b) => {
      status = s;
      body = b;
    });
    assert.equal(status, 200);
    assert.equal(body.privacyUsdAmountThreshold, 500);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(SHIPPED).sort());
  });
});
