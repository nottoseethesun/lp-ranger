"use strict";

/**
 * @file test/dashboard-throttle.test.js
 * @description Tests for throttle math, doubling window derivation, and DOM
 *   sync in `public/dashboard-throttle.js`.  Uses jsdom (via
 *   `global-jsdom/register`) to populate Node with real browser globals
 *   (`document`, `window`, `HTMLElement`, …) so the browser ES module
 *   can be imported directly and driven end-to-end.  No hand-rolled
 *   DOM stubs; no mirrored copy of the SUT — the test targets the real
 *   module, so any edit to `public/dashboard-throttle.js` that changes
 *   behaviour is observed by these assertions.
 *
 *   Regression under test (`dblWindowLabel`): commit e22536c deleted
 *   both writers of `#dblWindowLabel` in a "remove-dead-throttle-UI"
 *   cleanup pass.  The `#dblWindowLabel` element was NOT removed from
 *   `public/index.html`, so it lived on as a hardcoded `"40 min"`
 *   string.  The doubling trigger window IS `4 × minIntervalMs` in
 *   `src/throttle.js` (`window4 = 4 * state.minIntervalMs`) — anyone
 *   changing Min Time Between Rebalances from the default 10 min saw
 *   a wrong window label.  Silent because the element existed (no
 *   null-ref crash), and because most users never touched the setting.
 *   These tests pin the derivation and the DOM sync so a repeat
 *   deletion trips CI.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-throttle.js");
});

/*- Build the DOM structure the throttle module reads/writes and reset
 *  the module's live `throttle` state to a known baseline.  Every test
 *  starts with a fresh mount + baseline so state can't leak between
 *  tests. */
beforeEach(() => {
  document.body.innerHTML = `
    <input id="inMinInterval" value="10">
    <input id="inMaxReb" value="5">
    <input id="inOorTimeout" value="0">
    <span id="dblWindowLabel">40 min</span>
    <span id="throttleBadge"></span>
    <span id="kpiCountdown"></span>
    <div id="rangeBanner"></div>
    <span id="rangeIcon"></span>
    <span id="rangeLabel"></span>
  `;
  mod.throttle.minIntervalMs = 10 * 60 * 1000;
  mod.throttle.rebTimestamps = [];
  mod.throttle.doublingActive = false;
  mod.throttle.doublingCount = 0;
  mod.throttle.currentWaitMs = 10 * 60 * 1000;
  mod.throttle.lastRebTime = 0;
  mod.throttle.dailyCount = 0;
  mod.throttle.dailyMax = 5;
  mod.throttle.dailyResetAt = Date.now() + 86_400_000;
});

// ── Tests: canRebalance ────────────────────────────────────────────────────

describe("canRebalance()", () => {
  it("allows a fresh rebalance (no history, under daily cap)", () => {
    const check = mod.canRebalance();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.reason, "ok");
    assert.strictEqual(check.msUntilAllowed, 0);
  });

  it("blocks with daily_limit when dailyCount === dailyMax", () => {
    mod.throttle.dailyCount = mod.throttle.dailyMax;
    const check = mod.canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "daily_limit");
  });

  it("blocks with min_interval when last rebalance is inside minIntervalMs", () => {
    mod.throttle.lastRebTime = Date.now() - 60_000; // 1 min ago
    const check = mod.canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "min_interval");
    assert.ok(
      check.msUntilAllowed > 0 &&
        check.msUntilAllowed < mod.throttle.minIntervalMs,
      `expected 0 < msUntilAllowed < ${mod.throttle.minIntervalMs}, got ${check.msUntilAllowed}`,
    );
  });

  it("blocks with doubling reason when doubling mode is active and wait not elapsed", () => {
    mod.throttle.doublingActive = true;
    mod.throttle.currentWaitMs = 20 * 60 * 1000;
    mod.throttle.lastRebTime = Date.now() - 5 * 60_000;
    const check = mod.canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "doubling");
  });

  it("allows once minIntervalMs has elapsed since last rebalance", () => {
    mod.throttle.lastRebTime = Date.now() - mod.throttle.minIntervalMs - 1;
    const check = mod.canRebalance();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.reason, "ok");
  });
});

// ── Tests: dblWindowLabel — THE REGRESSION PIN ─────────────────────────────

describe("dblWindowLabel — regression pin for e22536c", () => {
  it("renders '40 min' at the 10-min default minIntervalMs (baseline)", () => {
    mod.throttle.minIntervalMs = 10 * 60 * 1000;
    mod.updateThrottleUI();
    assert.strictEqual(
      document.getElementById("dblWindowLabel").textContent,
      "40 min",
    );
  });

  it("renders '60 min' when minIntervalMs is 15 min (the user-reported case)", () => {
    mod.throttle.minIntervalMs = 15 * 60 * 1000;
    mod.updateThrottleUI();
    assert.strictEqual(
      document.getElementById("dblWindowLabel").textContent,
      "60 min",
    );
  });

  it("renders '20 min' when minIntervalMs is 5 min", () => {
    mod.throttle.minIntervalMs = 5 * 60 * 1000;
    mod.updateThrottleUI();
    assert.strictEqual(
      document.getElementById("dblWindowLabel").textContent,
      "20 min",
    );
  });

  it("no-op when the DOM element is missing (defensive)", () => {
    document.getElementById("dblWindowLabel").remove();
    assert.doesNotThrow(() => mod.updateThrottleUI());
  });

  it("scales by exactly 4× minIntervalMs — matches src/throttle.js window4", () => {
    for (const min of [1, 3, 7, 30, 60, 240]) {
      mod.throttle.minIntervalMs = min * 60 * 1000;
      mod.updateThrottleUI();
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        4 * min + " min",
        `minIntervalMs = ${min} min should give '${4 * min} min'`,
      );
    }
  });
});

// ── Tests: throttleBadge (via updateThrottleUI) ────────────────────────────

describe("throttleBadge (updateThrottleUI dispatch)", () => {
  it("CAPPED when dailyCount ≥ dailyMax", () => {
    mod.throttle.dailyCount = mod.throttle.dailyMax;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "CAPPED");
    assert.strictEqual(badge.className, "warn-badge");
  });

  it("DOUBLING ×N when doubling mode is active", () => {
    mod.throttle.doublingActive = true;
    mod.throttle.doublingCount = 2;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "DOUBLING ×3");
    assert.strictEqual(badge.className, "dbl-badge");
  });

  it("THROTTLED when last rebalance is inside min_interval", () => {
    mod.throttle.lastRebTime = Date.now() - 60_000;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "THROTTLED");
    assert.strictEqual(badge.className, "warn-badge");
  });

  it("NEAR LIMIT at 4/5 usage (80%) with no other state active", () => {
    mod.throttle.dailyCount = 4; // 4 / 5 = 80%
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "NEAR LIMIT");
    assert.strictEqual(badge.className, "warn-badge");
  });

  it("OK when idle and under 80% usage", () => {
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "OK");
    assert.strictEqual(badge.className, "live-badge");
  });
});

// ── Tests: onParamChange / saveMinInterval — the save-gated sync path ──────

describe("onParamChange() — typing must NOT move the saved-value displays", () => {
  it(
    "typing 15 into #inMinInterval WITHOUT clicking Save leaves " +
      "throttle.minIntervalMs and #dblWindowLabel unchanged " +
      "(the user-reported contract: label updates only on Save)",
    () => {
      document.getElementById("inMinInterval").value = "15";
      mod.onParamChange();
      assert.strictEqual(mod.throttle.minIntervalMs, 10 * 60 * 1000);
      mod.updateThrottleUI();
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "40 min",
      );
    },
  );

  it("updating #inMaxReb propagates to throttle.dailyMax", () => {
    document.getElementById("inMaxReb").value = "12";
    mod.onParamChange();
    assert.strictEqual(mod.throttle.dailyMax, 12);
  });
});

describe("saveMinInterval() — Save click applies the value + label", () => {
  it(
    "saving 15 propagates to throttle.minIntervalMs AND updates " +
      "#dblWindowLabel to '60 min' on the click itself (this would " +
      "have caught e22536c)",
    () => {
      document.getElementById("inMinInterval").value = "15";
      mod.saveMinInterval();
      assert.strictEqual(mod.throttle.minIntervalMs, 15 * 60 * 1000);
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "60 min",
      );
    },
  );

  it("rejects invalid input (empty / NaN / zero) — nothing changes", () => {
    for (const bad of ["", "abc", "0", "-3"]) {
      document.getElementById("inMinInterval").value = bad;
      mod.saveMinInterval();
      assert.strictEqual(
        mod.throttle.minIntervalMs,
        10 * 60 * 1000,
        `input ${JSON.stringify(bad)} must not change minIntervalMs`,
      );
    }
  });

  it(
    "when doubling is INACTIVE, currentWaitMs tracks the saved " +
      "minIntervalMs — the change reflects on the Save click",
    () => {
      document.getElementById("inMinInterval").value = "20";
      mod.throttle.doublingActive = false;
      mod.saveMinInterval();
      assert.strictEqual(mod.throttle.currentWaitMs, 20 * 60 * 1000);
    },
  );

  it(
    "when doubling is ACTIVE, currentWaitMs is NOT clobbered by " +
      "the saved minIntervalMs — the already-doubled wait persists",
    () => {
      document.getElementById("inMinInterval").value = "20";
      mod.throttle.doublingActive = true;
      mod.throttle.currentWaitMs = 80 * 60 * 1000;
      mod.saveMinInterval();
      assert.strictEqual(mod.throttle.currentWaitMs, 80 * 60 * 1000);
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "80 min",
      );
    },
  );
});
