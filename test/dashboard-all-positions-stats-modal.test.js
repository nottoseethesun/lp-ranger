"use strict";

/**
 * @file test/dashboard-all-positions-stats-modal.test.js
 * @description Tests for the pure helpers backing the sortable modal
 *   table in `public/dashboard-all-positions-stats.js`:
 *   - `_computeNumerics` — Net P&L / Profit / IL formulas mirrored
 *     from `_resolveKpiTotals`.  Previously private, now exported.
 *   - `_sortRows` — stable sort with null-bubbles-to-bottom.
 *     Previously private, now exported.
 *   - `daysAliveFor`, `applyPerDay`, `applyWeighted` — already exported.
 *
 *   Uses jsdom + direct import of the real module.  No mirror.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-all-positions-stats.js");
});

// ── _computeNumerics ──────────────────────────────────────────

describe("_computeNumerics()", () => {
  it("baseline formula (positive lifetime deposit)", () => {
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
    const nums = mod._computeNumerics(snap, /*ltRealized*/ 0, /*ltDep*/ 1000);
    // ltPc = 1200 - 1000 = 200
    // ltNetPnl = 200 + 30 + 50 + 0 - 5 + 0 - 0 = 275
    assert.strictEqual(nums.ltNetPnl, 275);
    // ltProfit = 50 + 30 - 5 + (-40) = 35
    assert.strictEqual(nums.ltProfit, 35);
    // ltIL = -40
    assert.strictEqual(nums.ltIL, -40);
  });

  it("zero deposit ⇒ price-change term zeroed out", () => {
    const snap = { currentValue: 5000, currentFeesUsd: 10 };
    const nums = mod._computeNumerics(snap, 0, 0);
    assert.strictEqual(nums.ltNetPnl, 10); // only the fees
  });

  it("prefers lifetimeIL over totalIL when both present", () => {
    const snap = { currentValue: 100, lifetimeIL: -5, totalIL: -99 };
    const nums = mod._computeNumerics(snap, 0, 100);
    assert.strictEqual(nums.ltIL, -5);
  });

  it("falls back to totalIL when lifetimeIL missing", () => {
    const snap = { currentValue: 100, totalIL: -12 };
    const nums = mod._computeNumerics(snap, 0, 100);
    assert.strictEqual(nums.ltIL, -12);
  });

  it("realized gains add to Net P&L but not to Profit", () => {
    const snap = { currentValue: 1000, currentFeesUsd: 0 };
    const nums = mod._computeNumerics(snap, /*ltRealized*/ 100, /*ltDep*/ 1000);
    assert.strictEqual(nums.ltNetPnl, 100); // 0 (ltPc) + 100 realized
    assert.strictEqual(nums.ltProfit, 0); // Profit intentionally excludes realized
  });

  it("initial residual is subtracted from Net P&L", () => {
    const snap = {
      currentValue: 1000,
      residualValueUsd: 50,
      initialResidualUsd: 30,
    };
    const nums = mod._computeNumerics(snap, 0, 1000);
    assert.strictEqual(nums.ltNetPnl, 0 + 50 - 30);
  });
});

// ── _sortRows ─────────────────────────────────────────────────

describe("_sortRows()", () => {
  it("DESC by numeric column", () => {
    const rows = [{ ltNetPnl: 100 }, { ltNetPnl: -50 }, { ltNetPnl: 200 }];
    const sorted = mod._sortRows(rows, "ltNetPnl", "desc");
    assert.deepStrictEqual(
      sorted.map((r) => r.ltNetPnl),
      [200, 100, -50],
    );
  });

  it("ASC by numeric column", () => {
    const rows = [{ ltNetPnl: 100 }, { ltNetPnl: -50 }, { ltNetPnl: 200 }];
    const sorted = mod._sortRows(rows, "ltNetPnl", "asc");
    assert.deepStrictEqual(
      sorted.map((r) => r.ltNetPnl),
      [-50, 100, 200],
    );
  });

  it("null / undefined bubble to the bottom regardless of direction", () => {
    const rows = [
      { ltNetPnl: 100 },
      { ltNetPnl: null },
      { ltNetPnl: 200 },
      { ltNetPnl: undefined },
      { ltNetPnl: -50 },
    ];
    const desc = mod._sortRows(rows, "ltNetPnl", "desc");
    assert.deepStrictEqual(
      desc.slice(0, 3).map((r) => r.ltNetPnl),
      [200, 100, -50],
    );
    assert.strictEqual(
      desc[3].ltNetPnl === null || desc[3].ltNetPnl === undefined,
      true,
    );
    assert.strictEqual(
      desc[4].ltNetPnl === null || desc[4].ltNetPnl === undefined,
      true,
    );

    const asc = mod._sortRows(rows, "ltNetPnl", "asc");
    assert.deepStrictEqual(
      asc.slice(0, 3).map((r) => r.ltNetPnl),
      [-50, 100, 200],
    );
    assert.strictEqual(
      asc[3].ltNetPnl === null || asc[3].ltNetPnl === undefined,
      true,
    );
    assert.strictEqual(
      asc[4].ltNetPnl === null || asc[4].ltNetPnl === undefined,
      true,
    );
  });

  it("does not mutate the input array", () => {
    const rows = [{ ltProfit: 3 }, { ltProfit: 1 }, { ltProfit: 2 }];
    const snapshot = rows.map((r) => r.ltProfit);
    mod._sortRows(rows, "ltProfit", "desc");
    assert.deepStrictEqual(
      rows.map((r) => r.ltProfit),
      snapshot,
    );
  });

  it("NaN bubbles to the bottom", () => {
    const rows = [{ ltIL: NaN }, { ltIL: 5 }, { ltIL: -3 }];
    const sorted = mod._sortRows(rows, "ltIL", "desc");
    assert.deepStrictEqual(
      sorted.slice(0, 2).map((r) => r.ltIL),
      [5, -3],
    );
    assert.ok(Number.isNaN(sorted[2].ltIL));
  });

  it("handles empty array", () => {
    assert.deepStrictEqual(mod._sortRows([], "ltNetPnl", "desc"), []);
  });
});

// ── daysAliveFor ──────────────────────────────────────────

describe("daysAliveFor()", () => {
  it("uses earliest of the three candidate dates", () => {
    const posState = {
      pnlSnapshot: { firstEpochDateUtc: "2026-06-01" },
      hodlBaseline: { mintDate: "2026-05-15" },
      poolFirstMintDate: "2026-07-01",
    };
    const now = Date.parse("2026-07-15T00:00:00Z");
    // Earliest is 2026-05-15 → 61 days to 2026-07-15
    assert.strictEqual(mod.daysAliveFor(posState, now), 61);
  });

  it("returns null when no date is available", () => {
    assert.strictEqual(
      mod.daysAliveFor({}, Date.parse("2026-07-15T00:00:00Z")),
      null,
    );
    assert.strictEqual(
      mod.daysAliveFor(
        { pnlSnapshot: { firstEpochDateUtc: null } },
        Date.parse("2026-07-15T00:00:00Z"),
      ),
      null,
    );
  });

  it("returns null when the span is <= 0", () => {
    const posState = { poolFirstMintDate: "2026-07-15" };
    const now = Date.parse("2026-07-15T00:00:00Z");
    assert.strictEqual(mod.daysAliveFor(posState, now), null);
  });

  it("accepts an ISO timestamp prefix", () => {
    const posState = {
      pnlSnapshot: { firstEpochDateUtc: "2026-07-01T12:34:56.789Z" },
    };
    const now = Date.parse("2026-07-11T00:00:00Z");
    // Truncated to "2026-07-01" → 10 days
    assert.strictEqual(mod.daysAliveFor(posState, now), 10);
  });
});

// ── applyPerDay ──────────────────────────────────────────

describe("applyPerDay()", () => {
  it("returns raw nums when toggle is off", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyPerDay(nums, false, 10), nums);
  });

  it("divides every field when toggle is on with positive days", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyPerDay(nums, true, 10), {
      ltNetPnl: 10,
      ltProfit: 5,
      ltIL: -1,
    });
  });

  it("falls through to raw nums when days is null / undefined / 0 / negative", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyPerDay(nums, true, null), nums);
    assert.deepStrictEqual(mod.applyPerDay(nums, true, undefined), nums);
    assert.deepStrictEqual(mod.applyPerDay(nums, true, 0), nums);
    assert.deepStrictEqual(mod.applyPerDay(nums, true, -5), nums);
  });

  it("preserves sign polarity for the sort-marker paint", () => {
    const nums = { ltNetPnl: -20, ltProfit: 0, ltIL: 10 };
    const perDay = mod.applyPerDay(nums, true, 4);
    assert.ok(perDay.ltNetPnl < 0);
    assert.strictEqual(perDay.ltProfit, 0);
    assert.ok(perDay.ltIL > 0);
  });
});

// ── applyWeighted ──────────────────────────────────────────

describe("applyWeighted()", () => {
  it("leaves oldest position at full weight (days == maxDays)", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyWeighted(nums, 100, 100), nums);
  });

  it("scales younger position by days / maxDays", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyWeighted(nums, 25, 100), {
      ltNetPnl: 25,
      ltProfit: 12.5,
      ltIL: -2.5,
    });
  });

  it("falls through to raw nums when days is null / undefined / 0 / negative", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyWeighted(nums, null, 100), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, undefined, 100), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, 0, 100), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, -5, 100), nums);
  });

  it("falls through to raw nums when maxDays is null / undefined / 0 / negative", () => {
    const nums = { ltNetPnl: 100, ltProfit: 50, ltIL: -10 };
    assert.deepStrictEqual(mod.applyWeighted(nums, 50, null), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, 50, undefined), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, 50, 0), nums);
    assert.deepStrictEqual(mod.applyWeighted(nums, 50, -5), nums);
  });

  it("preserves sign polarity", () => {
    const nums = { ltNetPnl: -20, ltProfit: 0, ltIL: 10 };
    const w = mod.applyWeighted(nums, 25, 100);
    assert.ok(w.ltNetPnl < 0);
    assert.strictEqual(w.ltProfit, 0);
    assert.ok(w.ltIL > 0);
  });
});
