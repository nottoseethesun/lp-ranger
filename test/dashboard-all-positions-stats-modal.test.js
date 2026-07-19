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

// ── Per-Day toggle helpers ────────────────────────────────────

/*- Mirrored copy of `daysAliveFor` from
 *  public/dashboard-all-positions-stats.js.  Same picker as
 *  `ltStartDate` in dashboard-date-utils.js so the Lifetime panel and
 *  this modal always report the same day count. */
function daysAliveFor(posState, now) {
  const candidates = [
    posState?.pnlSnapshot?.firstEpochDateUtc,
    posState?.hodlBaseline?.mintDate,
    posState?.poolFirstMintDate,
  ];
  let startDate = null;
  for (const c of candidates) {
    if (typeof c !== "string" || c.length < 10) continue;
    const truncated = c.slice(0, 10);
    if (startDate === null || truncated < startDate) startDate = truncated;
  }
  if (startDate === null) return null;
  const startMs = Date.parse(startDate + "T00:00:00Z");
  if (!Number.isFinite(startMs)) return null;
  const days = (now - startMs) / 86400000;
  return Number.isFinite(days) && days > 0 ? days : null;
}

function applyPerDay(nums, showPerDay, days) {
  if (!showPerDay) return nums;
  if (days === null || days === undefined || days <= 0) return nums;
  return {
    ltNetPnl: nums.ltNetPnl / days,
    ltProfit: nums.ltProfit / days,
    ltIL: nums.ltIL / days,
  };
}

function applyWeighted(nums, days, maxDays) {
  if (days === null || days === undefined || days <= 0) return nums;
  if (maxDays === null || maxDays === undefined || maxDays <= 0) return nums;
  const w = days / maxDays;
  return {
    ltNetPnl: nums.ltNetPnl * w,
    ltProfit: nums.ltProfit * w,
    ltIL: nums.ltIL * w,
  };
}

test("daysAliveFor: uses earliest of the three candidate dates", () => {
  const posState = {
    pnlSnapshot: { firstEpochDateUtc: "2026-06-01" },
    hodlBaseline: { mintDate: "2026-05-15" },
    poolFirstMintDate: "2026-07-01",
  };
  const now = Date.parse("2026-07-15T00:00:00Z");
  // Earliest is 2026-05-15 → 61 days to 2026-07-15
  assert.equal(daysAliveFor(posState, now), 61);
});

test("daysAliveFor: returns null when no date is available", () => {
  assert.equal(daysAliveFor({}, Date.parse("2026-07-15T00:00:00Z")), null);
  assert.equal(
    daysAliveFor(
      { pnlSnapshot: { firstEpochDateUtc: null } },
      Date.parse("2026-07-15T00:00:00Z"),
    ),
    null,
  );
});

test("daysAliveFor: returns null when the span is <= 0", () => {
  const posState = { poolFirstMintDate: "2026-07-15" };
  // Same day as start — span is 0
  const now = Date.parse("2026-07-15T00:00:00Z");
  assert.equal(daysAliveFor(posState, now), null);
});

test("daysAliveFor: accepts an ISO timestamp prefix", () => {
  const posState = {
    pnlSnapshot: { firstEpochDateUtc: "2026-07-01T12:34:56.789Z" },
  };
  const now = Date.parse("2026-07-11T00:00:00Z");
  // Truncated to "2026-07-01" → 10 days
  assert.equal(daysAliveFor(posState, now), 10);
});

test("applyPerDay: returns raw nums when toggle is off", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyPerDay(nums, false, 10), nums);
});

test("applyPerDay: divides every field when toggle is on with positive days", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyPerDay(nums, true, 10), {
    ltNetPnl: 10,
    ltProfit: 5,
    ltIL: -1,
  });
});

test("applyPerDay: falls through to raw nums when days is null / undefined / 0 / negative", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyPerDay(nums, true, null), nums);
  assert.deepEqual(applyPerDay(nums, true, undefined), nums);
  assert.deepEqual(applyPerDay(nums, true, 0), nums);
  assert.deepEqual(applyPerDay(nums, true, -5), nums);
});

test("applyPerDay: preserves sign polarity for the sort-marker paint", () => {
  const nums = { ltNetPnl: -20, ltProfit: 0, ltIL: 10 };
  const perDay = applyPerDay(nums, true, 4);
  // -20 / 4 = -5 (still negative), 0 stays 0, 10 / 4 = 2.5 (still positive)
  assert.ok(perDay.ltNetPnl < 0);
  assert.equal(perDay.ltProfit, 0);
  assert.ok(perDay.ltIL > 0);
});

test("applyWeighted: leaves oldest position at full weight (days == maxDays)", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyWeighted(nums, 100, 100), nums);
});

test("applyWeighted: scales younger position by days / maxDays", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  // Position is a quarter the age of the oldest → weight = 0.25.
  assert.deepEqual(applyWeighted(nums, 25, 100), {
    ltNetPnl: 25,
    ltProfit: 12.5,
    ltIL: -2.5,
  });
});

test("applyWeighted: falls through to raw nums when days is null / undefined / 0 / negative", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyWeighted(nums, null, 100), nums);
  assert.deepEqual(applyWeighted(nums, undefined, 100), nums);
  assert.deepEqual(applyWeighted(nums, 0, 100), nums);
  assert.deepEqual(applyWeighted(nums, -5, 100), nums);
});

test("applyWeighted: falls through to raw nums when maxDays is null / undefined / 0 / negative", () => {
  const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
  assert.deepEqual(applyWeighted(nums, 50, null), nums);
  assert.deepEqual(applyWeighted(nums, 50, undefined), nums);
  assert.deepEqual(applyWeighted(nums, 50, 0), nums);
  assert.deepEqual(applyWeighted(nums, 50, -5), nums);
});

test("applyWeighted: preserves sign polarity", () => {
  const nums = { ltNetPnl: -20, ltProfit: 0, ltIL: 10 };
  const w = applyWeighted(nums, 25, 100);
  // -20 × 0.25 = -5 (negative), 0 × 0.25 = 0, 10 × 0.25 = 2.5 (positive)
  assert.ok(w.ltNetPnl < 0);
  assert.equal(w.ltProfit, 0);
  assert.ok(w.ltIL > 0);
});
