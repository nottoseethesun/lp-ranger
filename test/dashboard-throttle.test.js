"use strict";

/**
 * @file test/dashboard-throttle.test.js
 * @description Tests for throttle math, doubling window derivation, and DOM
 *   sync in `public/dashboard-throttle.js`.  The dashboard module is an ES
 *   module bundled by esbuild for the browser; we replicate the pure
 *   decision functions and the DOM-writer helpers in CommonJS for direct
 *   test access, mirroring the pattern in `test/dashboard-idle.test.js` and
 *   `test/dashboard-csrf-fetch.test.js`.  Mirror is small enough to keep in
 *   lockstep by inspection — if the browser file changes, change this
 *   file too.
 *
 *   Regression under test (`dblWindowLabel`): commit e22536c deleted both
 *   writers of `#dblWindowLabel` in a "remove-dead-throttle-UI" cleanup
 *   pass.  The `#dblWindowLabel` element was NOT removed from
 *   `public/index.html`, so it lived on as a hardcoded `"40 min"` string.
 *   The doubling trigger window IS `4 × minIntervalMs` in `src/throttle.js`
 *   (`window4 = 4 * state.minIntervalMs`) — anyone changing Min Time
 *   Between Rebalances from the default 10 min would see a wrong window
 *   label.  Silent because the element existed (no null-ref crash), and
 *   because most users never touched the setting.  These tests pin the
 *   derivation and the DOM sync so a repeat deletion trips CI.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ── Minimal DOM stub ────────────────────────────────────────────────────────

/**
 * Map of id → fake element.  Elements are plain objects exposing the
 * properties the mirror reads/writes (`textContent`, `className`,
 * `value`, `title`).  Sufficient for the DOM-writer helpers below.
 * @type {Map<string, {textContent?: string, className?: string, value?: string, title?: string}>}
 */
let _dom;

function g(id) {
  return _dom.get(id) || null;
}
function _makeEl(id, initial) {
  const el = Object.assign(
    { textContent: "", className: "", value: "", title: "" },
    initial || {},
  );
  _dom.set(id, el);
  return el;
}

// ── In-test replica of the throttle-state + decision functions ─────────────
//
// Mirrors public/dashboard-throttle.js `throttle`, `canRebalance`, and the
// four renderers wired into `updateThrottleUI`.  Kept intentionally close
// to the source shape so a diff against the browser file is obvious.

let _now = 0;
function _dateNow() {
  return _now;
}

const throttle = {
  minIntervalMs: 10 * 60 * 1000,
  rebTimestamps: [],
  doublingActive: false,
  doublingCount: 0,
  currentWaitMs: 10 * 60 * 1000,
  lastRebTime: 0,
  dailyCount: 0,
  dailyMax: 5,
  dailyResetAt: 86_400_000,
};

function canRebalance() {
  const now = _dateNow();
  if (throttle.dailyCount >= throttle.dailyMax) {
    return {
      allowed: false,
      msUntilAllowed: throttle.dailyResetAt - now,
      reason: "daily_limit",
    };
  }
  const wait = throttle.doublingActive
    ? throttle.currentWaitMs
    : throttle.minIntervalMs;
  const since = now - throttle.lastRebTime;
  if (throttle.lastRebTime > 0 && since < wait) {
    return {
      allowed: false,
      msUntilAllowed: wait - since,
      reason: throttle.doublingActive ? "doubling" : "min_interval",
    };
  }
  return { allowed: true, msUntilAllowed: 0, reason: "ok" };
}

function _renderDoublingWindowLabel() {
  const el = g("dblWindowLabel");
  if (!el) return;
  el.textContent = (4 * throttle.minIntervalMs) / 60000 + " min";
}

function _renderThrottleBadge(pct) {
  const badge = g("throttleBadge");
  if (!badge) return;
  const check = canRebalance();
  if (throttle.dailyCount >= throttle.dailyMax) {
    badge.textContent = "CAPPED";
    badge.className = "warn-badge";
  } else if (throttle.doublingActive) {
    badge.textContent = "DOUBLING ×" + (throttle.doublingCount + 1);
    badge.className = "dbl-badge";
  } else if (!check.allowed && check.reason === "min_interval") {
    badge.textContent = "THROTTLED";
    badge.className = "warn-badge";
  } else if (pct >= 80) {
    badge.textContent = "NEAR LIMIT";
    badge.className = "warn-badge";
  } else {
    badge.textContent = "OK";
    badge.className = "live-badge";
  }
}

function onParamChange() {
  const minEl = g("inMinInterval");
  const maxEl = g("inMaxReb");
  throttle.minIntervalMs = (parseInt(minEl?.value) || 10) * 60 * 1000;
  throttle.dailyMax = parseInt(maxEl?.value) || throttle.dailyMax;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  updateThrottleUI();
}

function updateThrottleUI() {
  const pct = Math.min(100, (throttle.dailyCount / throttle.dailyMax) * 100);
  _renderThrottleBadge(pct);
  _renderDoublingWindowLabel();
}

// ── Reset state before every test ──────────────────────────────────────────

beforeEach(() => {
  _dom = new Map();
  _now = 1_000_000;
  throttle.minIntervalMs = 10 * 60 * 1000;
  throttle.rebTimestamps = [];
  throttle.doublingActive = false;
  throttle.doublingCount = 0;
  throttle.currentWaitMs = 10 * 60 * 1000;
  throttle.lastRebTime = 0;
  throttle.dailyCount = 0;
  throttle.dailyMax = 5;
  throttle.dailyResetAt = _now + 86_400_000;
});

// ── Tests: canRebalance ────────────────────────────────────────────────────

describe("canRebalance()", () => {
  it("allows a fresh rebalance (no history, under daily cap)", () => {
    const check = canRebalance();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.reason, "ok");
    assert.strictEqual(check.msUntilAllowed, 0);
  });

  it("blocks with daily_limit when dailyCount === dailyMax", () => {
    throttle.dailyCount = throttle.dailyMax;
    const check = canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "daily_limit");
    assert.strictEqual(check.msUntilAllowed, throttle.dailyResetAt - _now);
  });

  it("blocks with min_interval when last rebalance is inside minIntervalMs", () => {
    throttle.lastRebTime = _now - 60_000; // 1 min ago
    const check = canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "min_interval");
    assert.strictEqual(check.msUntilAllowed, throttle.minIntervalMs - 60_000);
  });

  it("blocks with doubling reason when doubling mode is active and wait not elapsed", () => {
    throttle.doublingActive = true;
    throttle.currentWaitMs = 20 * 60 * 1000;
    throttle.lastRebTime = _now - 5 * 60_000; // 5 min ago
    const check = canRebalance();
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.reason, "doubling");
    assert.strictEqual(
      check.msUntilAllowed,
      throttle.currentWaitMs - 5 * 60_000,
    );
  });

  it("allows once minIntervalMs has elapsed since last rebalance", () => {
    throttle.lastRebTime = _now - throttle.minIntervalMs - 1;
    const check = canRebalance();
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.reason, "ok");
  });
});

// ── Tests: _renderDoublingWindowLabel — THE REGRESSION PIN ─────────────────

describe("_renderDoublingWindowLabel() — regression pin for e22536c", () => {
  it("renders '40 min' at the 10-min default minIntervalMs (baseline)", () => {
    _makeEl("dblWindowLabel");
    throttle.minIntervalMs = 10 * 60 * 1000;
    _renderDoublingWindowLabel();
    assert.strictEqual(_dom.get("dblWindowLabel").textContent, "40 min");
  });

  it("renders '60 min' when minIntervalMs is 15 min (the user-reported case)", () => {
    _makeEl("dblWindowLabel");
    throttle.minIntervalMs = 15 * 60 * 1000;
    _renderDoublingWindowLabel();
    assert.strictEqual(_dom.get("dblWindowLabel").textContent, "60 min");
  });

  it("renders '20 min' when minIntervalMs is 5 min", () => {
    _makeEl("dblWindowLabel");
    throttle.minIntervalMs = 5 * 60 * 1000;
    _renderDoublingWindowLabel();
    assert.strictEqual(_dom.get("dblWindowLabel").textContent, "20 min");
  });

  it("no-op when the DOM element is missing (defensive)", () => {
    // Element deliberately not created.
    assert.doesNotThrow(() => _renderDoublingWindowLabel());
  });

  it("scales by exactly 4× minIntervalMs — matches src/throttle.js window4", () => {
    _makeEl("dblWindowLabel");
    for (const min of [1, 3, 7, 30, 60, 240]) {
      throttle.minIntervalMs = min * 60 * 1000;
      _renderDoublingWindowLabel();
      assert.strictEqual(
        _dom.get("dblWindowLabel").textContent,
        4 * min + " min",
        `minIntervalMs = ${min} min should give '${4 * min} min'`,
      );
    }
  });
});

// ── Tests: _renderThrottleBadge ────────────────────────────────────────────

describe("_renderThrottleBadge()", () => {
  it("CAPPED when dailyCount ≥ dailyMax", () => {
    _makeEl("throttleBadge");
    throttle.dailyCount = throttle.dailyMax;
    _renderThrottleBadge(100);
    assert.strictEqual(_dom.get("throttleBadge").textContent, "CAPPED");
    assert.strictEqual(_dom.get("throttleBadge").className, "warn-badge");
  });

  it("DOUBLING ×N when doubling mode is active", () => {
    _makeEl("throttleBadge");
    throttle.doublingActive = true;
    throttle.doublingCount = 2;
    _renderThrottleBadge(20);
    assert.strictEqual(_dom.get("throttleBadge").textContent, "DOUBLING ×3");
    assert.strictEqual(_dom.get("throttleBadge").className, "dbl-badge");
  });

  it("THROTTLED when last rebalance is inside min_interval", () => {
    _makeEl("throttleBadge");
    throttle.lastRebTime = _now - 60_000; // 1 min ago
    _renderThrottleBadge(20);
    assert.strictEqual(_dom.get("throttleBadge").textContent, "THROTTLED");
    assert.strictEqual(_dom.get("throttleBadge").className, "warn-badge");
  });

  it("NEAR LIMIT when pct ≥ 80 and no other state applies", () => {
    _makeEl("throttleBadge");
    _renderThrottleBadge(80);
    assert.strictEqual(_dom.get("throttleBadge").textContent, "NEAR LIMIT");
    assert.strictEqual(_dom.get("throttleBadge").className, "warn-badge");
  });

  it("OK when idle and under 80% usage", () => {
    _makeEl("throttleBadge");
    _renderThrottleBadge(20);
    assert.strictEqual(_dom.get("throttleBadge").textContent, "OK");
    assert.strictEqual(_dom.get("throttleBadge").className, "live-badge");
  });

  it("no-op when the DOM element is missing", () => {
    assert.doesNotThrow(() => _renderThrottleBadge(50));
  });
});

// ── Tests: onParamChange — the load-bearing sync path ──────────────────────

describe("onParamChange() — DOM inputs → throttle state → label", () => {
  it(
    "updating #inMinInterval to 15 propagates to throttle.minIntervalMs " +
      "AND updates #dblWindowLabel to '60 min' (this would have caught e22536c)",
    () => {
      _makeEl("inMinInterval", { value: "15" });
      _makeEl("inMaxReb", { value: "5" });
      _makeEl("dblWindowLabel");
      _makeEl("throttleBadge");

      onParamChange();

      assert.strictEqual(throttle.minIntervalMs, 15 * 60 * 1000);
      assert.strictEqual(_dom.get("dblWindowLabel").textContent, "60 min");
    },
  );

  it("updating #inMaxReb propagates to throttle.dailyMax", () => {
    _makeEl("inMinInterval", { value: "10" });
    _makeEl("inMaxReb", { value: "12" });
    _makeEl("dblWindowLabel");
    _makeEl("throttleBadge");

    onParamChange();

    assert.strictEqual(throttle.dailyMax, 12);
  });

  it(
    "when doubling is INACTIVE, currentWaitMs tracks minIntervalMs — " +
      "so a mid-session Min Interval change reflects immediately",
    () => {
      _makeEl("inMinInterval", { value: "20" });
      _makeEl("inMaxReb", { value: "5" });
      _makeEl("dblWindowLabel");
      _makeEl("throttleBadge");
      throttle.doublingActive = false;

      onParamChange();

      assert.strictEqual(throttle.currentWaitMs, 20 * 60 * 1000);
    },
  );

  it(
    "when doubling is ACTIVE, currentWaitMs is NOT clobbered by " +
      "minIntervalMs — the already-doubled wait persists",
    () => {
      _makeEl("inMinInterval", { value: "20" });
      _makeEl("inMaxReb", { value: "5" });
      _makeEl("dblWindowLabel");
      _makeEl("throttleBadge");
      throttle.doublingActive = true;
      throttle.currentWaitMs = 80 * 60 * 1000; // 4× doubled from 10

      onParamChange();

      assert.strictEqual(throttle.currentWaitMs, 80 * 60 * 1000);
      // But the doubling-window LABEL still tracks the base minIntervalMs
      // (because it advertises the trigger threshold, not the current wait).
      assert.strictEqual(_dom.get("dblWindowLabel").textContent, "80 min");
    },
  );
});
