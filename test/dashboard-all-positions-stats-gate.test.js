"use strict";

/**
 * @file test/dashboard-all-positions-stats-gate.test.js
 * @description Tests the readiness-gate decision the "All Positions
 *   Stats" header button uses.  The pure decision was extracted from
 *   `updateAllPositionsStatsBtn` into `computeAllPositionsStatsGate`
 *   in `public/dashboard-all-positions-stats.js` so it can be tested
 *   without driving the DOM cache path (whose module-singleton
 *   `_lastButtonState` cache would leak state between tests).  jsdom
 *   is still required — the module imports `dashboard-helpers.js`
 *   which touches browser globals at load time.
 *
 *   Gate contract:
 *     - zero running managed positions ⇒ disabled + "No managed positions"
 *     - some running not scan-complete   ⇒ disabled + "Waiting for X of Y…"
 *     - every running position ready     ⇒ enabled + "View ranked stats…"
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let compute;

before(async () => {
  ({ computeAllPositionsStatsGate: compute } =
    await import("../public/dashboard-all-positions-stats.js"));
});

describe("computeAllPositionsStatsGate()", () => {
  it("disabled + 'No managed positions' when nothing is running", () => {
    const r = compute({ _allPositionStates: {} });
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /No managed positions/);
  });

  it("disabled when a stopped position is present but no running ones", () => {
    const r = compute({
      _allPositionStates: {
        "k-stopped": { status: "stopped" },
      },
    });
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /No managed positions/);
  });

  it("disabled + 'Waiting for X of Y…' when one running position hasn't scanned yet", () => {
    const r = compute({
      _allPositionStates: {
        "k-loading": { status: "running" }, // no scan flags set
      },
    });
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /Waiting for 1 of 1 managed position\b/);
  });

  it("disabled with 'X of Y' when some running are ready and others aren't", () => {
    const r = compute({
      _allPositionStates: {
        "k-ready": {
          status: "running",
          rebalanceScanComplete: true,
          lifetimeScanComplete: true,
          pnlSnapshot: { any: 1 },
        },
        "k-loading": { status: "running" },
        "k-drained-loading": {
          status: "running",
          rebalanceScanComplete: true,
          // lifetimeScanComplete still missing
          pnlSnapshot: { any: 1 },
        },
      },
    });
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /Waiting for 2 of 3 managed positions/);
  });

  it("enabled when every running position is scan-complete AND has pnlSnapshot", () => {
    const r = compute({
      _allPositionStates: {
        "k-a": {
          status: "running",
          rebalanceScanComplete: true,
          lifetimeScanComplete: true,
          pnlSnapshot: { any: 1 },
        },
        "k-b": {
          status: "running",
          rebalanceScanComplete: true,
          lifetimeScanComplete: true,
          pnlSnapshot: { any: 2 },
        },
      },
    });
    assert.strictEqual(r.disabled, false);
    assert.match(r.title, /View ranked stats/);
  });

  it("running w/ scans complete but missing pnlSnapshot counts as not-ready", () => {
    const r = compute({
      _allPositionStates: {
        "k-no-snap": {
          status: "running",
          rebalanceScanComplete: true,
          lifetimeScanComplete: true,
          // pnlSnapshot missing
        },
      },
    });
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /Waiting for 1 of 1 managed position\b/);
  });

  it("stopped positions are excluded from the total", () => {
    const r = compute({
      _allPositionStates: {
        "k-running-ready": {
          status: "running",
          rebalanceScanComplete: true,
          lifetimeScanComplete: true,
          pnlSnapshot: { any: 1 },
        },
        "k-stopped": {
          status: "stopped",
          rebalanceScanComplete: false,
          lifetimeScanComplete: false,
        },
      },
    });
    assert.strictEqual(r.disabled, false);
    assert.match(r.title, /View ranked stats/);
  });

  it("handles missing _allPositionStates gracefully", () => {
    const r = compute({});
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /No managed positions/);
  });

  it("handles null data gracefully", () => {
    const r = compute(null);
    assert.strictEqual(r.disabled, true);
    assert.match(r.title, /No managed positions/);
  });
});
