"use strict";

/**
 * @file test/dashboard-throttle-server-only.test.js
 * @description The throttle badge, the Rebalance Interval countdown and
 *   the out-of-range banner show only what the server reported for the
 *   position on screen. The user, 2026-10-18: "The throttle badge, like
 *   everything in the app, must only read from what the server
 *   provides."
 *
 *   Three ways they showed something else. The daily-limit countdown ran
 *   to a midnight the page worked out once, at load, in local time, while
 *   the bot resets at midnight UTC, so a capped position's countdown was
 *   off by the time zone and read READY once the page had been open past
 *   that midnight. A managed position whose bot loop had not reported yet,
 *   one behind the startup stagger, showed the previous position's
 *   doubling, wait and cap, as did any position in the moment after a
 *   switch. And the banner's OOR timeout countdown read the Bot Settings
 *   field, unsaved typing included. Driven on the real page.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const A = {
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId: "101",
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "a2".repeat(20),
  fee: 2500,
  liquidity: "1000",
};
const B = { ...A, tokenId: "202", token0: "0x" + "b1".repeat(20) };

const MIN = 60_000;
let throttleMod, statusMod, store, positions, botConfig;

before(async () => {
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  throttleMod = await import("../public/dashboard-throttle.js");
  statusMod = await import("../public/dashboard-data-status.js");
  store = await import("../public/dashboard-positions-store.js");
  positions = await import("../public/dashboard-positions.js");
  ({ botConfig } = await import("../public/dashboard-helpers.js"));
  store.posStore.add(A);
  store.posStore.add(B);
  store.setPositionManaged(A.tokenId, true);
  store.setPositionManaged(B.tokenId, true);
});

const select = (p) =>
  store.posStore.select(
    store.posStore.entries.findIndex((e) => e.tokenId === p.tokenId),
  );

/** The page's own markup, with A on screen. */
beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  select(A);
});

const text = (id) => document.getElementById(id).textContent;

/** A status answer carrying A's bot loop, doubling and mid-wait. */
function doublingAnswer() {
  return {
    maxRebalancesPerDay: 5,
    minRebalanceIntervalMin: 10,
    throttleState: {
      dailyCount: 2,
      dailyMax: 5,
      doublingActive: true,
      doublingCount: 1,
      currentWaitMs: 40 * MIN,
      lastRebTime: Date.now() - MIN,
      dailyResetAt: Date.now() + 60 * MIN,
    },
  };
}

describe("the daily-limit countdown", () => {
  it("runs to the reset the server reports", () => {
    const resetAt = Date.now() + 127 * MIN;
    statusMod._updateThrottleKpis({
      maxRebalancesPerDay: 5,
      throttleState: {
        dailyCount: 5,
        dailyMax: 5,
        doublingActive: false,
        lastRebTime: 0,
        dailyResetAt: resetAt,
      },
    });
    const can = throttleMod.canRebalance();
    assert.equal(can.reason, "daily_limit");
    assert.ok(
      Math.abs(can.msUntilAllowed - (resetAt - Date.now())) < 1000,
      "counts to the server's reset",
    );
    throttleMod.updateThrottleUI();
    assert.match(text("kpiCountdown"), /^12[67]:\d\d — Daily Limit$/);
  });
});

describe("a managed position whose bot loop has not reported", () => {
  it("shows none of the previous position's throttle", () => {
    statusMod._updateThrottleKpis(doublingAnswer());
    throttleMod.updateThrottleUI();
    assert.match(text("throttleBadge"), /^DOUBLING/);
    select(B);
    statusMod._updateThrottleKpis({
      maxRebalancesPerDay: 5,
      minRebalanceIntervalMin: 10,
    });
    throttleMod.updateThrottleUI();
    assert.equal(text("throttleBadge"), "—", "not A's DOUBLING");
    assert.equal(throttleMod.throttle.doublingActive, false);
    assert.equal(throttleMod.canRebalance().allowed, true, "not A's wait");
    assert.equal(text("kpiCountdown"), "10 min", "its own saved interval");
  });

  it("is forgotten the moment another position is put on screen", () => {
    statusMod._updateThrottleKpis(doublingAnswer());
    throttleMod.updateThrottleUI();
    assert.match(text("throttleBadge"), /^DOUBLING/);
    assert.equal(positions.activateByTokenId(B.tokenId), true);
    assert.equal(text("throttleBadge"), "—", "before B's answer arrives");
    assert.equal(throttleMod.throttle.doublingActive, false);
    assert.equal(throttleMod.throttle.minIntervalMs, null);
  });
});

describe("the banner's OOR timeout countdown", () => {
  /** Put A out of range, inside the threshold, for ten minutes now. */
  function outOfRangeTenMinutes() {
    Object.assign(botConfig, {
      price: 2,
      lower: 0.5,
      upper: 1,
      withinThreshold: true,
      residualCleanupInProgress: false,
      oorSince: Date.now() - 10 * MIN,
    });
  }

  it("counts down the timeout the server reports, not the field", () => {
    outOfRangeTenMinutes();
    throttleMod.injectThrottleDeps({
      getLastStatus: () => ({ rebalanceTimeoutMin: 30 }),
    });
    document.getElementById("inOorTimeout").value = "999";
    throttleMod.updateThrottleUI();
    assert.match(text("rangeLabel"), /Timeout: (19|20):\d\d$/);
  });

  it("shows none before the server has reported a timeout", () => {
    outOfRangeTenMinutes();
    throttleMod.injectThrottleDeps({ getLastStatus: () => null });
    document.getElementById("inOorTimeout").value = "30";
    throttleMod.updateThrottleUI();
    assert.equal(text("rangeLabel"), "OUT OF RANGE — WITHIN THRESHOLD");
  });
});
