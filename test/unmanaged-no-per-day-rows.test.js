/**
 * @file test/unmanaged-no-per-day-rows.test.js
 * @description An unmanaged position must not ship Per-Day P&L rows.
 *
 *   The leak is indirect: the epoch cache is keyed by POOL, not by
 *   position. A pool that was managed at some
 *   point leaves epochs in it, `computeLifetimeDetails` restores them
 *   into its tracker, and `tracker.snapshot()` then builds per-day rows
 *   out of them. A position in that pool that was never managed
 *   inherits the lot and arrives on screen with a populated table it has
 *   no business showing.
 *
 *   A position in a pool that was never managed shows nothing either
 *   way, so a fixture without cached epochs cannot tell the fix from its
 *   absence. These drive the case that can: epochs present.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _withoutPerDayRows } = require("../src/position-details");

/** A snapshot as `tracker.snapshot()` returns one, rows included. */
function snapshotWithRows() {
  return {
    dailyPnl: [
      { date: "2026-09-04", feePnl: 35.64, gasCost: 0.04 },
      { date: "2026-08-08", feePnl: 35.19, gasCost: 0.04 },
    ],
    currentValue: 1309.9,
    totalGas: 0.09,
    totalCompoundedUsd: 20.53,
    lifetimeIL: -94.41,
  };
}

describe("_withoutPerDayRows", () => {
  it("drops the rows a pool-managed-before position left behind", () => {
    const out = _withoutPerDayRows(snapshotWithRows());
    assert.equal(
      out.dailyPnl,
      undefined,
      "an unmanaged view has no Per-Day table to fill",
    );
  });

  it("keeps everything the Current panel is built from", () => {
    /*-
     *  The rows are the only thing being withheld. Removing the whole
     *  snapshot would blank Fees Compounded, Gas and Current Value,
     *  which this view does show.
     */
    const out = _withoutPerDayRows(snapshotWithRows());
    assert.equal(out.currentValue, 1309.9);
    assert.equal(out.totalGas, 0.09);
    assert.equal(out.totalCompoundedUsd, 20.53);
    assert.equal(out.lifetimeIL, -94.41);
  });

  it("does not mutate the caller's snapshot", () => {
    /*-
     *  The same object is handed to `_enrichSnap` and cached upstream;
     *  deleting in place would strip the rows from the tracker's own
     *  serialization on the way to the epoch cache.
     */
    const original = snapshotWithRows();
    _withoutPerDayRows(original);
    assert.equal(original.dailyPnl.length, 2, "the input must be untouched");
  });

  it("passes an empty snapshot straight through", () => {
    /*-
     *  A never-managed pool yields `{}` — no epochs, no rows. There is
     *  nothing to drop and nothing to fail on.
     */
    assert.deepEqual(_withoutPerDayRows({}), {});
  });

  it("tolerates null and undefined", () => {
    assert.equal(_withoutPerDayRows(null), null);
    assert.equal(_withoutPerDayRows(undefined), undefined);
  });
});
