"use strict";

/**
 * @file test/shutdown-timing.test.js
 * @description How long a stop may take. The server exits by itself
 *   `exitTimeoutMs` after a SIGTERM; `npm stop` falls back to SIGKILL only
 *   after that plus `stopKillMarginMs`. The kill is the backup, so it must
 *   never come first, and a mistyped figure must refuse to run rather
 *   than leave a stop that kills at once.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  readShutdownTimings,
  shutdownTimingsFrom,
} = require("../src/shutdown-timing");
const shipped = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");

describe("shutdown timings", () => {
  it("reads the shipped group, with the kill strictly after the server's own exit", () => {
    const t = readShutdownTimings();
    assert.equal(t.exitTimeoutMs, shipped.shutdown.exitTimeoutMs);
    assert.equal(
      t.killAfterMs,
      shipped.shutdown.exitTimeoutMs + shipped.shutdown.stopKillMarginMs,
    );
    assert.equal(t.checkIntervalMs, shipped.shutdown.stopCheckIntervalMs);
    assert.ok(t.killAfterMs > t.exitTimeoutMs);
  });

  for (const key of [
    "exitTimeoutMs",
    "stopKillMarginMs",
    "stopCheckIntervalMs",
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
  }
});
