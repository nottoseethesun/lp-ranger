/**
 * @file test/gecko-rate-limit.test.js
 * @description Tests for the shared GeckoTerminal sliding-window rate limiter.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  geckoRateLimit,
  noteGecko429,
  _getPenaltyUntilMs,
  _resetForTest,
  _MAX_CALLS,
} = require("../src/gecko-rate-limit");

describe("gecko-rate-limit", () => {
  let _origSetTimeout;

  beforeEach(() => {
    _resetForTest();
    _origSetTimeout = global.setTimeout;
  });

  afterEach(() => {
    global.setTimeout = _origSetTimeout;
    _resetForTest();
  });

  it("allows calls up to _MAX_CALLS without waiting", async () => {
    global.setTimeout = () => {
      throw new Error("should not sleep under the limit");
    };
    for (let i = 0; i < _MAX_CALLS; i++) {
      await geckoRateLimit();
    }
  });

  it("waits before the (_MAX_CALLS + 1)th call", async () => {
    let slept = false;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) slept = true;
      return _origSetTimeout(fn, 0); // fast-forward during test
    };
    for (let i = 0; i < _MAX_CALLS; i++) await geckoRateLimit();
    assert.equal(slept, false, "no sleep up to the limit");
    await geckoRateLimit();
    assert.equal(slept, true, "should have slept on the overflow call");
  });

  it("resets cleanly for tests", async () => {
    // Fill the window, then reset and verify budget is restored.
    global.setTimeout = (fn) => _origSetTimeout(fn, 0);
    for (let i = 0; i < _MAX_CALLS; i++) await geckoRateLimit();
    _resetForTest();
    let slept = false;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) slept = true;
      return _origSetTimeout(fn, 0);
    };
    for (let i = 0; i < _MAX_CALLS; i++) await geckoRateLimit();
    assert.equal(slept, false, "after reset, budget should be fresh");
  });

  // ── noteGecko429 / cool-down ─────────────────────────────────────────────

  it("noteGecko429 advances the penalty timestamp", () => {
    const before = _getPenaltyUntilMs();
    noteGecko429(5_000);
    const after = _getPenaltyUntilMs();
    assert.ok(after > before, "penalty timestamp should increase");
    assert.ok(
      after >= Date.now() + 4_900,
      "penalty should be ~5s in the future",
    );
  });

  it("noteGecko429 does NOT shrink an existing longer penalty", () => {
    noteGecko429(60_000);
    const long = _getPenaltyUntilMs();
    noteGecko429(1_000);
    assert.strictEqual(
      _getPenaltyUntilMs(),
      long,
      "short penalty must not overwrite an existing longer one",
    );
  });

  it("geckoRateLimit() waits when a 429 penalty is active", async () => {
    let sleepMs = 0;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) sleepMs = ms;
      return _origSetTimeout(fn, 0);
    };
    noteGecko429(2_000);
    await geckoRateLimit();
    assert.ok(sleepMs > 0, "should have slept due to 429 penalty");
    assert.ok(
      sleepMs <= 2_000,
      `sleep should be at most the penalty (~2s), got ${sleepMs}`,
    );
  });

  it("geckoRateLimit() does NOT wait once the penalty has expired", async () => {
    // Set a tiny penalty, let it expire naturally.
    noteGecko429(1);
    await new Promise((r) => _origSetTimeout(r, 5));
    let slept = false;
    global.setTimeout = (fn, ms) => {
      if (ms > 0) slept = true;
      return _origSetTimeout(fn, 0);
    };
    await geckoRateLimit();
    assert.equal(slept, false, "expired penalty should not cause a sleep");
  });
});
