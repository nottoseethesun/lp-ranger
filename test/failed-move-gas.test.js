"use strict";

/**
 * @file test/failed-move-gas.test.js
 * @description The gas failed rebalances and compounds paid comes back
 *   after the P&L periods are rebuilt, and is counted once.
 *
 *   It is kept in the position's records (`failedMoveGas`, written by
 *   src/lib/spent-gas.js), never in a period, and the P&L adds each charge to
 *   the period it was paid in whenever it works the figures out
 *   (`snapshot`, src/lib/pnl-tracker.js). Reload Current Position rebuilds
 *   the closed periods from the chain, which shows none of this gas, and
 *   a cleared scan cache also starts the open period afresh at the
 *   restart. The user approved, 2026-10-19: "When the periods are
 *   rebuilt, each charge goes back into the period it was paid in. Day
 *   to day nothing on screen changes, and after a Reload the figures
 *   come back as they were."
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPnlTracker } = require("../src/lib/pnl-tracker");
const {
  RECORD_POSITION_KEYS,
  CHAIN_DERIVED_POSITION_KEYS,
} = require("../src/lib/bot-config-keys");

const DAY = 86_400_000;
const now = Date.now();
// A period of ten days that a rebalance closed five days ago.
const OPENED = now - 15 * DAY;
const CLOSED = now - 5 * DAY;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** An open period, as the bot keeps one, from `openTime`. */
const openPeriod = (openTime) => ({
  id: 1,
  entryValue: 1000,
  entryPrice: 0.001,
  lowerPrice: 0.0005,
  upperPrice: 0.002,
  openTime,
  fees: 0,
  il: 0,
  gas: 0,
  gasNative: 0,
  priceChangePnl: 0,
  feePnl: 0,
  importedGas: 0,
  importedGasNative: 0,
  status: "open",
});

// One failed move in the closed period, and one in the open period.
const CHARGES = [
  {
    at: new Date(OPENED + 3 * DAY).toISOString(),
    wei: "20000000000000000",
    usd: 0.2,
  },
  {
    at: new Date(CLOSED + 2 * DAY).toISOString(),
    wei: "10000000000000000",
    usd: 0.1,
  },
];

/** Each row's gas: its day, dollars and coins. */
const gasRows = (snap) =>
  snap.dailyPnl.map((r) => [r.date, r.gasCost, r.gasNative]);

/*-
 *  Day to day: the first period closes at a rebalance that paid 0.3 of
 *  gas, and the next one opens. The failed moves' charges are recorded,
 *  and never added to a period.
 */
function dayToDay() {
  const t = createPnlTracker();
  t.restore({ closedEpochs: [], liveEpoch: openPeriod(OPENED) });
  t.closeEpoch({
    exitValue: 1010,
    gasCost: 0.3,
    gasNative: 0.03,
    closeTime: CLOSED,
  });
  t.restore({
    closedEpochs: t.serialize().closedEpochs,
    liveEpoch: openPeriod(CLOSED),
  });
  return t;
}

/** A tracker holding `closedEpochs` and an open period from `openTime`. */
function trackerWith(closedEpochs, openTime) {
  const t = createPnlTracker();
  t.restore({ closedEpochs, liveEpoch: openPeriod(openTime) });
  return t;
}

describe("the gas failed moves paid", () => {
  it("goes on the row of the period each was paid in, and in the lifetime total", () => {
    const snap = dayToDay().snapshot(0.001, CHARGES);
    const row = (t) => snap.dailyPnl.find((r) => r.date === dayOf(t));
    assert.ok(Math.abs(row(CLOSED).gasCost - (0.3 + 0.2)) < 1e-9);
    assert.ok(Math.abs(row(now).gasCost - 0.1) < 1e-9, "the open period's");
    assert.ok(Math.abs(snap.totalGas - 0.6) < 1e-9);
    assert.ok(Math.abs(snap.totalGasNative - 0.06) < 1e-9);
  });

  it("is never added to a period, so none is counted twice", () => {
    const t = dayToDay();
    t.snapshot(0.001, CHARGES);
    const second = t.snapshot(0.001, CHARGES);
    assert.equal(t.serialize().closedEpochs[0].gas, 0.3);
    assert.equal(t.serialize().liveEpoch.gas, 0);
    assert.ok(Math.abs(second.totalGas - 0.6) < 1e-9);
  });

  it("comes back as it was after a Reload, and after a cleared scan cache", () => {
    const seen = dayToDay().snapshot(0.001, CHARGES);
    // The closed period as the chain rebuilds it: its own gas, no more.
    const rebuilt = JSON.parse(
      JSON.stringify(dayToDay().serialize().closedEpochs),
    );
    // Reload keeps the open period; a cleared cache starts it at restart.
    for (const openTime of [CLOSED, now]) {
      const snap = trackerWith(rebuilt, openTime).snapshot(0.001, CHARGES);
      assert.deepEqual(gasRows(snap), gasRows(seen));
      assert.ok(Math.abs(snap.totalGas - seen.totalGas) < 1e-9);
    }
  });

  it("is a record that Reload Current Position leaves in place", () => {
    /*-
     *  Reload clears the chain-derived records, which the scan it starts
     *  rebuilds. The chain does not show this gas, so clearing it would
     *  lose it for good.
     */
    assert.ok(RECORD_POSITION_KEYS.includes("failedMoveGas"));
    assert.ok(!CHAIN_DERIVED_POSITION_KEYS.includes("failedMoveGas"));
  });
});
