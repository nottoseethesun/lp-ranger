"use strict";

/**
 * @file test/per-day-missing-price-dash.test.js
 * @description A period whose prices could not be read shows a dash in
 *   the Per-Day P&L table, never figures valued at today's prices.
 *   Followed through each step that carries it: the history leaves an
 *   earlier day's unread price unread (src/position-history.js, tested in
 *   closed-position-history.test.js); the epoch built from that history
 *   is marked as missing a price (`_buildClosedEpoch`,
 *   src/epoch-reconstructor.js); its day keeps the mark
 *   (`_buildDailyPnl`, src/pnl-tracker.js); and the table writes a dash
 *   in every money column of that day (`renderDailyPnl`,
 *   public/dashboard-history.js).
 *
 *   A period whose gas token had no price on the day it closed is
 *   followed the same way: its coins are priced, so only the day's Gas,
 *   and the Profit and Net P&L that subtract it, show a dash.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { _buildClosedEpoch } = require("../src/epoch-reconstructor");
const { _buildDailyPnl } = require("../src/pnl-tracker");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

/*-
 *  A closed NFT's history whose prices were not read: its coins valued at
 *  unread prices come to zero, which is what marks the period.
 */
const unpriced = {
  tokenId: "889",
  mintDate: "2026-09-01T12:00:00.000Z",
  closeDate: "2026-09-03T12:00:00.000Z",
  entryValueUsd: 0,
  exitValueUsd: 0,
  feesEarnedUsd: 4.2,
  gasCostUsd: 0.3,
  gasNative: 1,
  entryAmount0: 10,
  entryAmount1: 20,
  token0UsdPriceAtOpen: null,
  token1UsdPriceAtOpen: null,
  token0UsdPriceAtClose: null,
  token1UsdPriceAtClose: null,
};

let history;

before(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await learnActiveChain();
  history = await import("../public/dashboard-history.js");
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...["dailyPnlBody", "tplDailyPnlRow"].map((id) =>
      document.importNode(page.getElementById(id), true),
    ),
  );
});

describe("a period whose prices could not be read", () => {
  it("is marked as missing a price when its epoch is built", () => {
    assert.equal(_buildClosedEpoch(unpriced, 0).missingPrice, true);
  });

  it("keeps the mark on its day", () => {
    const [day] = _buildDailyPnl([_buildClosedEpoch(unpriced, 0)], null);
    assert.equal(day.missingPrice, true);
  });

  it("shows a dash in every money column of the Per-Day table", () => {
    const days = _buildDailyPnl([_buildClosedEpoch(unpriced, 0)], null);
    history.renderDailyPnl(days);
    const [date, ...money] = [
      ...document.querySelectorAll("#dailyPnlBody td"),
    ].map((td) => td.textContent);
    assert.equal(date, days[0].date);
    assert.ok(money.length > 0, "the row has money columns");
    for (const text of money) assert.equal(text, "—", money.join(" | "));
  });
});

/*-
 *  A closed NFT whose coins were priced, but whose gas token had no price
 *  on the day it closed: the amount of gas is known, its dollar figure is
 *  not (`pastGasCostUsd`, src/bot-pnl-updater.js).
 */
const gasUnpriced = {
  ...unpriced,
  tokenId: "890",
  entryValueUsd: 100,
  exitValueUsd: 110,
  token0UsdPriceAtOpen: 1,
  token1UsdPriceAtOpen: 1,
  token0UsdPriceAtClose: 2,
  token1UsdPriceAtClose: 1,
  gasCostUsd: null,
};

/** The same period's coins and gas all priced, closing two days later. */
const priced = {
  ...gasUnpriced,
  tokenId: "891",
  mintDate: "2026-09-03T12:00:00.000Z",
  closeDate: "2026-09-05T12:00:00.000Z",
  gasCostUsd: 0.3,
};

/** The text of each money cell of the table's one row. */
function rowCells() {
  const cell = (k) =>
    document.querySelector(`#dailyPnlBody [data-tpl="${k}"]`).textContent;
  const keys = ["fees", "gas", "priceChange", "profit", "net"];
  return Object.fromEntries(keys.map((k) => [k, cell(k)]));
}

describe("a period whose gas token had no price on its day", () => {
  it("builds, with its gas and net figure unknown and its coins priced", () => {
    const ep = _buildClosedEpoch(gasUnpriced, 0);
    assert.equal(ep.gas, null);
    assert.equal(ep.epochPnl, null);
    assert.equal(ep.missingPrice, false);
  });

  it("leaves its day's gas and net unknown, and other days whole", () => {
    const [later, earlier] = _buildDailyPnl(
      [_buildClosedEpoch(gasUnpriced, 0), _buildClosedEpoch(priced, 1)],
      null,
    );
    assert.equal(earlier.gasCost, null);
    assert.equal(earlier.netPnl, null);
    assert.equal(later.gasCost, 0.3);
    assert.equal(typeof later.netPnl, "number");
  });

  it("shows a dash for Gas, Profit and Net P&L, and its other figures", () => {
    history.renderDailyPnl(
      _buildDailyPnl([_buildClosedEpoch(gasUnpriced, 0)], null),
    );
    const cells = rowCells();
    for (const k of ["gas", "profit", "net"]) assert.equal(cells[k], "—", k);
    for (const k of ["fees", "priceChange"])
      assert.notEqual(cells[k], "—", `${k}: ${cells[k]}`);
  });
});
