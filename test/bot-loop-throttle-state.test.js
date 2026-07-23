/**
 * @file test/bot-loop-throttle-state.test.js
 * @description Tests for the `throttleState` emissions from
 * `pollCycle` (src/bot-cycle.js via src/bot-loop.js).  Split from
 * test/bot-loop-pnl.test.js when that file hit the 500-line cap.
 *
 * Emission contract: a fresh `throttleState` snapshot is emitted on
 * EVERY poll cycle (top of pollCycle, after `throttle.tick()`) and
 * after a successful rebalance.  (The former throttle-rejection-site
 * emit was removed as redundant — the top-of-poll emit already
 * published the snapshot; the rejection-path test below now passes
 * via that emit.)  The
 * every-poll emit is the fix for the stale-snapshot bug where a quiet
 * position served the startup snapshot (global default interval)
 * forever and the dashboard's Doubling Trigger Window label read 4x
 * the wrong value after a page refresh.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const { _poll } = require("./_bot-loop-helpers");
const { _resetForTest } = require("../src/gecko-rate-limit");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

// ── throttleState ───────────────────────────────────────────────────────────

describe("bot-loop: throttleState in updateBotState", () => {
  it(
    "emits a fresh throttleState on EVERY poll — including a quiet " +
      "in-range poll with no rebalance and no throttle rejection " +
      "(regression: stale startup snapshot made the Doubling Trigger " +
      "Window label read 4× the global default after a page refresh)",
    async () => {
      const { stateUpdates } = await _poll(0, {
        collectStates: true,
        setupDeps: (d) => {
          d.throttle.getState = () => ({
            dailyCount: 1,
            dailyMax: 20,
            minIntervalMs: 20 * 60_000,
          });
        },
      });
      const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
      assert.ok(ts, "throttleState must be emitted on a quiet in-range poll");
      assert.strictEqual(
        ts.minIntervalMs,
        20 * 60_000,
        "snapshot must carry the throttle's current (config-applied) interval",
      );
    },
  );

  it("emits throttleState after a successful rebalance", async () => {
    const { stateUpdates } = await _poll(700, {
      collectStates: true,
      setupDeps: (d) => {
        d.throttle.getState = () => ({ dailyCount: 3, dailyMax: 20 });
      },
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, "throttleState should be emitted after rebalance");
    assert.strictEqual(ts.dailyCount, 3);
  });
  it("emits throttleState when throttle rejects", async () => {
    const { stateUpdates } = await _poll(700, {
      botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      collectStates: true,
      setupDeps: (d) => {
        d.throttle.canRebalance = () => ({
          allowed: false,
          msUntilAllowed: 60000,
          reason: "daily_max",
        });
        d.throttle.getState = () => ({ dailyCount: 20, dailyMax: 20 });
      },
    });
    const ts = stateUpdates.find((u) => u.throttleState)?.throttleState;
    assert.ok(ts, "throttleState should be emitted on throttle rejection");
    assert.strictEqual(ts.dailyCount, 20);
  });
});
