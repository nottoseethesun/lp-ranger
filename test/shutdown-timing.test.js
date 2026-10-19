"use strict";

/**
 * @file test/shutdown-timing.test.js
 * @description How long a stop may take. The server exits by itself
 *   `exitTimeoutMs` after a SIGTERM; `npm stop` falls back to SIGKILL only
 *   after that plus `stopKillMarginMs`. The kill is the backup, so it must
 *   never come first, and a mistyped figure must refuse to run rather
 *   than leave a stop that kills at once. `npm run gentle-stop` waits
 *   `gentleStopPollMs` between two questions, checked the same way.
 *
 *   The group read is an operator's own, each figure moved off what
 *   ships, so a figure written into the code fails.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("shutdown-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "app-runtime.json"),
  JSON.stringify({
    shutdown: {
      exitTimeoutMs: 4000,
      stopKillMarginMs: 1500,
      stopCheckIntervalMs: 250,
      gentleStopPollMs: 240000,
    },
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  readShutdownTimings,
  shutdownTimingsFrom,
} = require("../src/shutdown-timing");
const { SETTING_BOUNDS } = require("../src/setting-bounds");
const shipped = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");

describe("shutdown timings", () => {
  it("reads the group, an override included, with the kill strictly after the server's own exit", () => {
    const t = readShutdownTimings();
    assert.deepEqual(t, {
      exitTimeoutMs: 4000,
      killAfterMs: 5500,
      checkIntervalMs: 250,
      gentleStopPollMs: 240000,
    });
    assert.ok(t.killAfterMs > t.exitTimeoutMs);
  });

  for (const key of [
    "exitTimeoutMs",
    "stopKillMarginMs",
    "stopCheckIntervalMs",
    "gentleStopPollMs",
  ]) {
    for (const bad of [undefined, 0, -5, "3000", 1.5]) {
      it(`refuses ${String(bad)} for ${key}, naming it`, () => {
        const group = { ...shipped.shutdown, [key]: bad };
        assert.throws(
          () => shutdownTimingsFrom(group),
          new RegExp(`shutdown\\.${key}`),
        );
      });
    }

    /*-
     *  The range the startup check holds the setting to, so a value it
     *  lets the server start on never keeps `npm stop` from running.
     */
    const { min, max } = SETTING_BOUNDS.timers.settings[key];
    it(`holds ${key} to its range in setting-bounds.json, ${min} to ${max}`, () => {
      for (const ok of [min, max])
        assert.doesNotThrow(() =>
          shutdownTimingsFrom({ ...shipped.shutdown, [key]: ok }),
        );
      for (const bad of [min - 1, max + 1])
        assert.throws(
          () => shutdownTimingsFrom({ ...shipped.shutdown, [key]: bad }),
          new RegExp(`shutdown\\.${key}`),
        );
    });
  }
});
