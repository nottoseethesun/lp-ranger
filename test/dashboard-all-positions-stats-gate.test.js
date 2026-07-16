"use strict";

/**
 * @file test/dashboard-all-positions-stats-gate.test.js
 * @description Unit tests for the pure readiness-gate decision the
 *   "All Positions Stats" header button uses.  The production function
 *   lives in `public/dashboard-all-positions-stats.js` (browser ES
 *   module — same DOM-import constraint as other dashboard modules
 *   we mirror-test).  Kept in sync with production; if the gating
 *   contract changes, update both.
 *
 *   Gate contract (per `updateAllPositionsStatsBtn`):
 *     - zero running managed positions ⇒ disabled + "No managed positions" tooltip
 *     - some running not scan-complete   ⇒ disabled + "Waiting for X of Y…" tooltip
 *     - every running position ready     ⇒ enabled + "View ranked stats…" tooltip
 *
 * @see public/dashboard-all-positions-stats.js
 */

const { test } = require("node:test");
const assert = require("node:assert");

// ── Mirrored copy of the pure decision from dashboard-all-positions-stats.js ──

/**
 * Compute {disabled, title} from a flattened /api/status payload.
 * @param {object} data
 * @returns {{disabled: boolean, title: string}}
 */
function computeButtonState(data) {
  const positions = data?._allPositionStates || {};
  let total = 0;
  let ready = 0;
  for (const key of Object.keys(positions)) {
    const p = positions[key];
    if (!p || p.status !== "running") continue;
    total += 1;
    if (
      p.rebalanceScanComplete === true &&
      p.lifetimeScanComplete === true &&
      p.pnlSnapshot
    )
      ready += 1;
  }
  if (total === 0) {
    return {
      disabled: true,
      title: "No managed positions — click Manage on a position to add one.",
    };
  }
  if (ready < total) {
    const missing = total - ready;
    const plural = total === 1 ? "" : "s";
    return {
      disabled: true,
      title: `Waiting for ${missing} of ${total} managed position${plural} to finish loading (rebalance history + lifetime deposit scans).`,
    };
  }
  return {
    disabled: false,
    title: "View ranked stats across all open managed positions.",
  };
}

// ── Test cases ────────────────────────────────────────────────

test("disabled + 'No managed positions' when nothing is running", () => {
  const r = computeButtonState({ _allPositionStates: {} });
  assert.equal(r.disabled, true);
  assert.match(r.title, /No managed positions/);
});

test("disabled when a stopped position is present but no running ones", () => {
  const r = computeButtonState({
    _allPositionStates: {
      "k-stopped": { status: "stopped" },
    },
  });
  assert.equal(r.disabled, true);
  assert.match(r.title, /No managed positions/);
});

test("disabled + 'Waiting for X of Y…' when one running position hasn't scanned yet", () => {
  const r = computeButtonState({
    _allPositionStates: {
      "k-loading": { status: "running" }, // no scan flags set
    },
  });
  assert.equal(r.disabled, true);
  assert.match(r.title, /Waiting for 1 of 1 managed position\b/);
});

test("disabled with 'X of Y' when some running are ready and others aren't", () => {
  const r = computeButtonState({
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
  assert.equal(r.disabled, true);
  assert.match(r.title, /Waiting for 2 of 3 managed positions/);
});

test("enabled when every running position is scan-complete AND has pnlSnapshot", () => {
  const r = computeButtonState({
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
  assert.equal(r.disabled, false);
  assert.match(r.title, /View ranked stats/);
});

test("running w/ scans complete but missing pnlSnapshot counts as not-ready", () => {
  const r = computeButtonState({
    _allPositionStates: {
      "k-no-snap": {
        status: "running",
        rebalanceScanComplete: true,
        lifetimeScanComplete: true,
        // pnlSnapshot missing
      },
    },
  });
  assert.equal(r.disabled, true);
  assert.match(r.title, /Waiting for 1 of 1 managed position\b/);
});

test("stopped positions are excluded from the total", () => {
  const r = computeButtonState({
    _allPositionStates: {
      "k-running-ready": {
        status: "running",
        rebalanceScanComplete: true,
        lifetimeScanComplete: true,
        pnlSnapshot: { any: 1 },
      },
      "k-stopped": {
        status: "stopped",
        rebalanceScanComplete: false, // shouldn't matter
        lifetimeScanComplete: false,
      },
    },
  });
  assert.equal(r.disabled, false);
  assert.match(r.title, /View ranked stats/);
});

test("handles missing _allPositionStates gracefully", () => {
  const r = computeButtonState({});
  assert.equal(r.disabled, true);
  assert.match(r.title, /No managed positions/);
});

test("handles null data gracefully", () => {
  const r = computeButtonState(null);
  assert.equal(r.disabled, true);
  assert.match(r.title, /No managed positions/);
});
