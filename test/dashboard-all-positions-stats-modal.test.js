"use strict";

/**
 * @file test/dashboard-all-positions-stats-modal.test.js
 * @description Unit tests for the pure functions inside
 *   `public/dashboard-all-positions-stats.js` that back the sortable
 *   modal table: _sortRows (stable sort with null-bubbles-to-bottom)
 *   and _computeNumerics (lifetime P&L / Profit / IL formulas
 *   mirrored from _resolveKpiTotals in dashboard-data-kpi.js).
 *
 *   Same mirror-test pattern used elsewhere in the dashboard suite —
 *   the production module imports DOM globals at load, so node:test
 *   can't require it directly.  Keep the two copies in sync when the
 *   contract changes.
 *
 * @see public/dashboard-all-positions-stats.js
 */

const { test } = require("node:test");
const assert = require("node:assert");

// ── Mirrored copies ────────────────────────────────────────────

function _num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function _computeNumerics(snap, ltRealized, ltDep) {
  const currentValue = _num(snap.currentValue, 0);
  const ltPc = ltDep > 0 ? currentValue - ltDep : 0;
  const compounded = _num(snap.totalCompoundedUsd, 0);
  const ltCurrentFees = _num(snap.currentFeesUsd, 0);
  const ltGas = _num(snap.totalGas, 0);
  const ltResidual = _num(snap.residualValueUsd, 0);
  const ltInitialResidual = _num(snap.initialResidualUsd, 0);
  const il = _num(snap.lifetimeIL ?? snap.totalIL, 0);
  const ltNetPnl =
    ltPc +
    compounded +
    ltCurrentFees +
    ltRealized -
    ltGas +
    ltResidual -
    ltInitialResidual;
  const ltProfit = ltCurrentFees + compounded - ltGas + il;
  return { ltNetPnl, ltProfit, ltIL: il };
}

function _sortRows(rows, col, dir) {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    const an = av === null || av === undefined || Number.isNaN(av);
    const bn = bv === null || bv === undefined || Number.isNaN(bv);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (av === bv) return 0;
    return av < bv ? -sign : sign;
  });
}

// ── _computeNumerics ──────────────────────────────────────────

test("computeNumerics: baseline formula (positive lifetime deposit)", () => {
  // Position minted at $1000, now worth $1200, fees earned $50 unclaimed +
  // $30 compounded, gas $5, no residuals, IL of -$40, no realized gains.
  const snap = {
    currentValue: 1200,
    totalCompoundedUsd: 30,
    currentFeesUsd: 50,
    totalGas: 5,
    residualValueUsd: 0,
    initialResidualUsd: 0,
    lifetimeIL: -40,
  };
  const nums = _computeNumerics(snap, /*ltRealized*/ 0, /*ltDep*/ 1000);
  // ltPc = 1200 - 1000 = 200
  // ltNetPnl = 200 + 30 + 50 + 0 - 5 + 0 - 0 = 275
  assert.equal(nums.ltNetPnl, 275);
  // ltProfit = 50 + 30 - 5 + (-40) = 35
  assert.equal(nums.ltProfit, 35);
  // ltIL = -40
  assert.equal(nums.ltIL, -40);
});

test("computeNumerics: zero deposit ⇒ price-change term zeroed out", () => {
  // Guard case from _priceChangePnl: if deposit isn't known, we omit
  // the price-change contribution rather than reporting cv - 0.
  const snap = { currentValue: 5000, currentFeesUsd: 10 };
  const nums = _computeNumerics(snap, 0, 0);
  assert.equal(nums.ltNetPnl, 10); // only the fees
});

test("computeNumerics: prefers lifetimeIL over totalIL when both present", () => {
  const snap = { currentValue: 100, lifetimeIL: -5, totalIL: -99 };
  const nums = _computeNumerics(snap, 0, 100);
  assert.equal(nums.ltIL, -5);
});

test("computeNumerics: falls back to totalIL when lifetimeIL missing", () => {
  const snap = { currentValue: 100, totalIL: -12 };
  const nums = _computeNumerics(snap, 0, 100);
  assert.equal(nums.ltIL, -12);
});

test("computeNumerics: realized gains add to Net P&L but not to Profit", () => {
  const snap = { currentValue: 1000, currentFeesUsd: 0 };
  const nums = _computeNumerics(snap, /*ltRealized*/ 100, /*ltDep*/ 1000);
  assert.equal(nums.ltNetPnl, 100); // 0 (ltPc) + 100 realized
  assert.equal(nums.ltProfit, 0); // Profit intentionally excludes realized
});

test("computeNumerics: initial residual is subtracted from Net P&L", () => {
  const snap = {
    currentValue: 1000,
    residualValueUsd: 50,
    initialResidualUsd: 30,
  };
  const nums = _computeNumerics(snap, 0, 1000);
  assert.equal(nums.ltNetPnl, 0 + 50 - 30);
});

// ── _sortRows ─────────────────────────────────────────────────

test("sortRows: DESC by numeric column", () => {
  const rows = [{ ltNetPnl: 100 }, { ltNetPnl: -50 }, { ltNetPnl: 200 }];
  const sorted = _sortRows(rows, "ltNetPnl", "desc");
  assert.deepEqual(
    sorted.map((r) => r.ltNetPnl),
    [200, 100, -50],
  );
});

test("sortRows: ASC by numeric column", () => {
  const rows = [{ ltNetPnl: 100 }, { ltNetPnl: -50 }, { ltNetPnl: 200 }];
  const sorted = _sortRows(rows, "ltNetPnl", "asc");
  assert.deepEqual(
    sorted.map((r) => r.ltNetPnl),
    [-50, 100, 200],
  );
});

test("sortRows: null / undefined bubble to the bottom regardless of direction", () => {
  const rows = [
    { ltNetPnl: 100 },
    { ltNetPnl: null },
    { ltNetPnl: 200 },
    { ltNetPnl: undefined },
    { ltNetPnl: -50 },
  ];
  const desc = _sortRows(rows, "ltNetPnl", "desc");
  // Non-null values sorted desc first, nulls trailing.
  assert.deepEqual(
    desc.slice(0, 3).map((r) => r.ltNetPnl),
    [200, 100, -50],
  );
  assert.equal(
    desc[3].ltNetPnl === null || desc[3].ltNetPnl === undefined,
    true,
  );
  assert.equal(
    desc[4].ltNetPnl === null || desc[4].ltNetPnl === undefined,
    true,
  );

  const asc = _sortRows(rows, "ltNetPnl", "asc");
  assert.deepEqual(
    asc.slice(0, 3).map((r) => r.ltNetPnl),
    [-50, 100, 200],
  );
  assert.equal(asc[3].ltNetPnl === null || asc[3].ltNetPnl === undefined, true);
  assert.equal(asc[4].ltNetPnl === null || asc[4].ltNetPnl === undefined, true);
});

test("sortRows: doesn't mutate the input array", () => {
  const rows = [{ ltProfit: 3 }, { ltProfit: 1 }, { ltProfit: 2 }];
  const snapshot = rows.map((r) => r.ltProfit);
  _sortRows(rows, "ltProfit", "desc");
  assert.deepEqual(
    rows.map((r) => r.ltProfit),
    snapshot,
  );
});

test("sortRows: NaN bubbles to the bottom", () => {
  const rows = [{ ltIL: NaN }, { ltIL: 5 }, { ltIL: -3 }];
  const sorted = _sortRows(rows, "ltIL", "desc");
  assert.deepEqual(
    sorted.slice(0, 2).map((r) => r.ltIL),
    [5, -3],
  );
  assert.ok(Number.isNaN(sorted[2].ltIL));
});

test("sortRows: handles empty array", () => {
  assert.deepEqual(_sortRows([], "ltNetPnl", "desc"), []);
});
