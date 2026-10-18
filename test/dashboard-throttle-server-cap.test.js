"use strict";

/**
 * @file test/dashboard-throttle-server-cap.test.js
 * @description The throttle badge and the day's rebalance count show
 *   only what the server reports. Typing in Max Rebalances / Day changes
 *   neither before a Save; a Save writes no guess of its own; and the
 *   count takes the saved cap from the status answer the moment it
 *   carries one, not from the bot's throttle snapshot, which changes only
 *   at the bot's next check. Before, a keystroke moved the badge, a Save
 *   wrote "0 / 7" over an unmanaged position's N/A or "3 / NaN" for an
 *   emptied field, and the old cap stayed on screen until that check.
 *   Driven on the real page, with the dashboard's own event handlers
 *   bound.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

let throttleMod;
let statusMod;

before(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await learnActiveChain();
  await learnUiSettings();
  throttleMod = await import("../public/dashboard-throttle.js");
  statusMod = await import("../public/dashboard-data-status.js");
  const events = await import("../public/dashboard-events.js");
  document.body.innerHTML = indexHtmlDocument().body.innerHTML;
  events.bindAllEvents();
});

const text = (id) => document.getElementById(id).textContent;

describe("Max Rebalances / Day and what the page shows of it", () => {
  it("a keystroke moves neither the badge's cap nor its text", () => {
    throttleMod.throttle.dailyMax = 5;
    throttleMod.throttle.dailyCount = 4;
    throttleMod.updateThrottleUI();
    const before = text("throttleBadge");
    const input = document.getElementById("inMaxReb");
    input.value = "12";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    throttleMod.updateThrottleUI();
    assert.equal(throttleMod.throttle.dailyMax, 5);
    assert.equal(text("throttleBadge"), before);
  });

  it("a Save writes nothing of its own into the day's count", () => {
    const today = document.getElementById("kpiToday");
    const input = document.getElementById("inMaxReb");
    today.textContent = "N/A";
    input.value = "7";
    throttleMod.saveMaxReb();
    assert.equal(today.textContent, "N/A", "no 0 / 7 for an unmanaged one");
    today.textContent = "3 / 5";
    input.value = "";
    throttleMod.saveMaxReb();
    assert.equal(today.textContent, "3 / 5", "no 3 / NaN");
  });

  it("the count shows the saved cap the status answer carries", () => {
    /*-
     *  Saved as 7; the bot's snapshot still says 5 until its next check,
     *  which is also when it starts using 7.
     */
    statusMod._updateThrottleKpis({
      maxRebalancesPerDay: 7,
      throttleState: { dailyMax: 5, dailyCount: 3 },
    });
    assert.equal(text("kpiToday"), "3 / 7");
    assert.equal(throttleMod.throttle.dailyMax, 7, "and the badge agrees");
  });

  it("shows a dash, never a made-up figure, while the server names no cap", () => {
    statusMod._updateThrottleKpis({ throttleState: { dailyCount: 0 } });
    assert.equal(text("kpiToday"), "—");
    throttleMod.updateThrottleUI();
    assert.equal(text("throttleBadge"), "—");
  });
});
