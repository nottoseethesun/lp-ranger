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
