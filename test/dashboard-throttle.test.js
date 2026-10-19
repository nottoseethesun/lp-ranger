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
 *   string.  The doubling trigger window is `triggerWindowMultiple`
 *   times the minimum interval, the rule `src/throttle.js` enforces from
 *   bot-config-defaults.json → `throttleDoubling` — anyone changing Min
 *   Time Between
 *   Rebalances from the default 10 min saw a wrong window label.  Silent
 *   because the element existed (no null-ref crash), and because most
 *   users never touched the setting.  These tests pin the derivation and
 *   the DOM sync so a repeat deletion trips CI.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadShippedDefaults } = require("../src/load-merged-defaults");
const { learnUiSettings } = require("./helpers/ui-settings");

/*-
 *  The NEAR LIMIT threshold the server sends, moved off its shipped
 *  value, so the badge is seen to read the setting in force.
 */
const NEAR_LIMIT_PCT =
  loadShippedDefaults("ui-defaults_non-layout_for-server-up-scenario.json")
    .throttleNearLimitPct - 15;

const BOT = loadShippedDefaults("bot-config-defaults.json");
const TRIGGER_WINDOW_MULTIPLE = BOT.throttleDoubling.triggerWindowMultiple;

let mod;

before(async () => {
  mod = await import("../public/dashboard-throttle.js");
  await learnUiSettings({ throttleNearLimitPct: NEAR_LIMIT_PCT });
  /*-
   *  The label takes the doubling rule from the defaults the server
   *  sends with the help's figures: the rule as the bot enforces it,
   *  overrides included. A server running on the shipped settings
   *  stands in for it.
   */
  const figures = await import("../public/dashboard-help-figures.js");
  await figures.loadHelpFigures({
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ figures: {}, botDefaults: BOT }),
    }),
    warnFn: () => assert.fail("answered at once"),
    onUnanswered: () => {},
    onAnswered: () => {},
  });
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

  it("scales by the bot's own trigger-window multiple", () => {
    for (const min of [1, 3, 7, 30, 60, 240]) {
      const want = TRIGGER_WINDOW_MULTIPLE * min + " min";
      mod.throttle.minIntervalMs = min * 60 * 1000;
      mod.updateThrottleUI();
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        want,
        `minIntervalMs = ${min} min should give '${want}'`,
      );
    }
  });

  it("follows the doubling rule the server sends, an override included", async () => {
    const figures = await import("../public/dashboard-help-figures.js");
    const load = (botDefaults) =>
      figures.loadHelpFigures({
        fetchFn: async () => ({
          ok: true,
          json: async () => ({ figures: {}, botDefaults }),
        }),
        warnFn: () => assert.fail("answered at once"),
        onUnanswered: () => {},
        onAnswered: () => {},
      });
    await load({
      ...BOT,
      throttleDoubling: { ...BOT.throttleDoubling, triggerWindowMultiple: 7 },
    });
    try {
      mod.throttle.minIntervalMs = 10 * 60 * 1000;
      mod.updateThrottleUI();
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "70 min",
      );
    } finally {
      await load(BOT);
    }
  });

  it("shows a dash, not a made-up window, before any interval is known", () => {
    /*-
     *  Nothing supplies the interval until the first status poll or a
     *  Save, and the dashboard holds no default of its own to stand in.
     */
    mod.throttle.minIntervalMs = null;
    mod.throttle.currentWaitMs = null;
    mod.updateThrottleUI();
    assert.strictEqual(
      document.getElementById("dblWindowLabel").textContent,
      "—",
    );
    assert.strictEqual(
      document.getElementById("kpiCountdown").textContent,
      "—",
    );
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

  it("NEAR LIMIT once usage reaches throttleNearLimitPct, with no other state active", () => {
    mod.throttle.dailyMax = 100;
    mod.throttle.dailyCount = NEAR_LIMIT_PCT;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "NEAR LIMIT");
    assert.strictEqual(badge.className, "warn-badge");
  });

  it("OK one rebalance short of throttleNearLimitPct", () => {
    mod.throttle.dailyMax = 100;
    mod.throttle.dailyCount = NEAR_LIMIT_PCT - 1;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "OK");
  });

  it("OK when idle and under throttleNearLimitPct usage", () => {
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "OK");
    assert.strictEqual(badge.className, "live-badge");
  });

  it("a dash, not CAPPED, before the daily cap is known", () => {
    /*-
     *  Nothing supplies the cap until the first status poll. A zero
     *  standing in for it read as reached, so a managed position's badge
     *  said CAPPED, and rebalancing looked blocked, before anything was
     *  known.
     */
    mod.throttle.dailyMax = null;
    mod.updateThrottleUI();
    const badge = document.getElementById("throttleBadge");
    assert.strictEqual(badge.textContent, "—");
    assert.notStrictEqual(mod.canRebalance().reason, "daily_limit");
  });
});

// ── Tests: typing and the save-gated sync path ─────────────────────────────

describe("typing must NOT move the saved-value displays", () => {
  it(
    "typing 15 into #inMinInterval WITHOUT clicking Save leaves " +
      "throttle.minIntervalMs and #dblWindowLabel unchanged " +
      "(the user-reported contract: label updates only on Save)",
    () => {
      document.getElementById("inMinInterval").value = "15";
      mod.updateThrottleUI();
      assert.strictEqual(mod.throttle.minIntervalMs, 10 * 60 * 1000);
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "40 min",
      );
    },
  );

  it("typing into #inMaxReb leaves the badge's cap where the server put it", () => {
    // The cap is the server's: only its status answer may move it.
    document.getElementById("inMaxReb").value = "12";
    mod.updateThrottleUI();
    assert.strictEqual(mod.throttle.dailyMax, 5);
  });
});

describe("applySavedMinInterval() — per-position seed from saved config", () => {
  it(
    "seeds throttle.minIntervalMs + the label from the saved value — " +
      "the dashboard-only-mode fix (no bot loop → no throttleState in " +
      "the payload; saved config is the only source)",
    () => {
      mod.applySavedMinInterval(20);
      assert.strictEqual(mod.throttle.minIntervalMs, 20 * 60 * 1000);
      assert.strictEqual(
        document.getElementById("dblWindowLabel").textContent,
        "80 min",
      );
      assert.strictEqual(mod.throttle.currentWaitMs, 20 * 60 * 1000);
    },
  );

  it("does not clobber currentWaitMs while doubling is active", () => {
    mod.throttle.doublingActive = true;
    mod.throttle.currentWaitMs = 80 * 60 * 1000;
    mod.applySavedMinInterval(20);
    assert.strictEqual(mod.throttle.currentWaitMs, 80 * 60 * 1000);
  });

  it("ignores invalid input (undefined / NaN / zero / negative)", () => {
    for (const bad of [undefined, NaN, 0, -5]) {
      mod.applySavedMinInterval(bad);
      assert.strictEqual(
        mod.throttle.minIntervalMs,
        10 * 60 * 1000,
        `input ${bad} must not change minIntervalMs`,
      );
    }
  });

  it("accepts a string-typed saved value (hand-edited config)", () => {
    mod.applySavedMinInterval("20");
    assert.strictEqual(mod.throttle.minIntervalMs, 20 * 60 * 1000);
  });

  it("countdown KPI renders the SAVED value, not the raw input (audit fix)", () => {
    document.getElementById("inMinInterval").value = "60"; // unsaved typing
    mod.applySavedMinInterval(20);
    assert.strictEqual(
      document.getElementById("kpiCountdown").textContent,
      "20 min",
      "allowed-branch KPI must derive from throttle.minIntervalMs",
    );
  });
});

describe("applyPolledMinInterval() — the value a status answer carries", () => {
  it("applies the answer's value at once", () => {
    mod.applyPolledMinInterval(15 * 60 * 1000);
    assert.strictEqual(mod.throttle.minIntervalMs, 15 * 60 * 1000);
  });

  it("non-numeric polled values are ignored", () => {
    mod.applyPolledMinInterval(undefined);
    mod.applyPolledMinInterval(null);
    assert.strictEqual(mod.throttle.minIntervalMs, 10 * 60 * 1000);
  });
});

describe("saveMinInterval() — the server's answer, not the click, moves the display", () => {
  /** The Doubling Trigger Window label for a minimum of `min` minutes. */
  const windowLabel = (min) => `${min * TRIGGER_WINDOW_MULTIPLE} min`;

  it(
    "a Save leaves the throttle and the Doubling Trigger Window label as " +
      "they were, and the status answer carrying the saved value moves them",
    () => {
      const label = document.getElementById("dblWindowLabel");
      mod.updateThrottleUI();
      document.getElementById("inMinInterval").value = "15";
      mod.saveMinInterval();
      mod.updateThrottleUI();
      assert.strictEqual(mod.throttle.minIntervalMs, 10 * 60 * 1000);
      assert.strictEqual(label.textContent, windowLabel(10));

      mod.applyPolledMinInterval(15 * 60 * 1000);
      mod.updateThrottleUI();
      assert.strictEqual(label.textContent, windowLabel(15));
    },
  );

  it("never shows a value the server's answer does not carry", () => {
    document.getElementById("inMinInterval").value = "15";
    mod.saveMinInterval();
    // The answer still carries the old value: refused, or not saved yet.
    mod.applyPolledMinInterval(10 * 60 * 1000);
    mod.updateThrottleUI();
    assert.strictEqual(
      document.getElementById("dblWindowLabel").textContent,
      windowLabel(10),
    );
  });
});

/*- A refused save is `public/dashboard-config-save.js`'s job now, and
 *  is covered by test/dashboard-config-save.test.js. */

describe("the OOR timeout badge", () => {
  it("says Turned Off for 0, the minutes otherwise, a dash before it is known", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<span id="activeOorTimeout"></span>',
    );
    const shown = (rebalanceTimeoutMin) => {
      mod.updateTriggerDisplay({ rebalanceTimeoutMin });
      return document.getElementById("activeOorTimeout").textContent;
    };
    assert.equal(shown(0), "Turned Off");
    assert.equal(shown(120), "120");
    assert.equal(shown(undefined), "—");
  });
});
