/**
 * @file test/live-epoch-entry.test.js
 * @description Guards the entry value recorded when a live P&L epoch is
 *   re-opened.
 *
 *   The live epoch is not persisted, so every reconstruction discards it
 *   and the next poll opens a fresh one. Neither open site may stamp
 *   the position's value at that moment, or the figure moves on every
 *   restart: the Per-Day table's In/Out cell for the day the current
 *   NFT was minted is `exit(previous) - entry(current)`, so it reports
 *   a different number each time the process comes up for one finished
 *   rebalance.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLiveEntryValue,
  ensureLiveEpoch,
} = require("../src/live-epoch-entry");

/** Tracker double that records what it was opened with. */
function tracker(live) {
  return {
    _live: live || null,
    opened: [],
    getLiveEpoch() {
      return this._live;
    },
    openEpoch(p) {
      this.opened.push(p);
      this._live = p;
    },
  };
}

const MINTED = { hodlBaseline: { entryValue: 3947.23 } };

describe("resolveLiveEntryValue", () => {
  it("prefers the NFT's mint value over the position's value now", () => {
    assert.equal(resolveLiveEntryValue(MINTED, 2778.46), 3947.23);
  });

  it("falls back to the current value when no baseline has resolved", () => {
    assert.equal(resolveLiveEntryValue({}, 2778.46), 2778.46);
    assert.equal(resolveLiveEntryValue(null, 2778.46), 2778.46);
    assert.equal(resolveLiveEntryValue(undefined, 2778.46), 2778.46);
  });

  it("ignores a baseline that is zero, negative or not a number", () => {
    /*- A half-initialised baseline must not stamp a nonsense entry. */
    for (const bad of [0, -5, null, undefined, "3947.23", NaN]) {
      const st = { hodlBaseline: { entryValue: bad } };
      assert.equal(resolveLiveEntryValue(st, 2778.46), 2778.46);
    }
  });
});

describe("ensureLiveEpoch", () => {
  it("gives the same answer however the position's value has moved", () => {
    /*- The drift regression: one finished mint, three restarts at
     *  different position values, one entry value. */
    const seen = [2656.94, 2705.87, 2778.46].map((v) => {
      const t = tracker(null);
      ensureLiveEpoch(t, MINTED, { currentValue: v, entryPrice: 1 });
      return t.opened[0].entryValue;
    });
    assert.deepEqual(seen, [3947.23, 3947.23, 3947.23]);
  });

  it("does nothing when an epoch is already open", () => {
    const t = tracker({ entryValue: 1 });
    assert.equal(ensureLiveEpoch(t, MINTED, { currentValue: 500 }), false);
    assert.equal(t.opened.length, 0);
  });

  it("refuses to open at zero, since the position may be mid-rebalance", () => {
    /*- Between drain and mint the position holds nothing; opening then
     *  would anchor the epoch at 0. */
    const t = tracker(null);
    assert.equal(ensureLiveEpoch(t, {}, { currentValue: 0 }), false);
    assert.equal(t.opened.length, 0);
  });

  it("carries the range and prices through to the epoch", () => {
    const t = tracker(null);
    ensureLiveEpoch(t, MINTED, {
      currentValue: 10,
      entryPrice: 0.0026,
      lowerPrice: 0.002,
      upperPrice: 0.003,
      price0: 1.5,
      price1: 2.5,
    });
    assert.deepEqual(t.opened[0], {
      entryValue: 3947.23,
      entryPrice: 0.0026,
      lowerPrice: 0.002,
      upperPrice: 0.003,
      token0UsdPrice: 1.5,
      token1UsdPrice: 2.5,
    });
  });

  it("tolerates a missing tracker", () => {
    assert.equal(ensureLiveEpoch(null, MINTED, { currentValue: 10 }), false);
  });
});
