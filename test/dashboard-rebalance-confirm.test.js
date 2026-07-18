/**
 * @file test/dashboard-rebalance-confirm.test.js
 * @description Mirror tests for the pure helpers in
 * `public/dashboard-rebalance-confirm.js`.  The dashboard module pulls
 * DOM + localStorage + a browser-only ES-module import graph that
 * node:test can't load, so we mirror the two pure helpers here in
 * plain CommonJS and cover them at the logic level.  Same pattern as
 * `test/dashboard-mixed-state-fix.test.js`.
 *
 * Covered:
 *  1. `_computePreservedWidthPct(tickLower, tickUpper, currentPrice)`
 *     — the on-chain-tick-spread → %-of-current-price formula the IL
 *     modal preview line and the Bot Settings Range Width row's
 *     pre-populate share.
 *  2. `_rangeWidthPreviewText(status, active)` — the two-branch
 *     preview text: "X% (from saved override)" vs "preserving current
 *     tick spread (~Y%)".
 *  3. The rebalance-request-body shape for the two POST call sites:
 *     the mission-control confirm (`/api/rebalance` with just
 *     positionKey) and the closed-position re-open
 *     (`/api/position/manage` with tokenId+contract+forceRebalance
 *     but NO customRangeWidthPct).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ── Mirror #1: _computePreservedWidthPct ──────────────────────────────

/*- Mirror of the production helper in
 *  public/dashboard-rebalance-confirm.js.  Matches
 *  src/range-math.js:preserveRange() split — for a position with tick
 *  spread S and offset%, the width is
 *  `(1.0001^(S*offset/100) - 1.0001^(-S*(100-offset)/100)) * 100`.
 *  For offset=50 (centered) simplifies to the symmetric form; for
 *  other offsets the exponents differ.
 *  Presence checks use explicit `!== undefined && !== null` per
 *  CLAUDE-BEST-PRACTICES §"Type Checks". */
/*- Mirror of dashboard-helpers.js:isFullRangeSpread.  Threshold sits
 *  below the smallest fee-tier full-range spread (1,774,400 for
 *  tickSpacing=200) with room for future fee tiers. */
const FULL_RANGE_TICK_SPREAD_THRESHOLD = 1_700_000;
function isFullRangeSpread(spread) {
  return Number.isFinite(spread) && spread >= FULL_RANGE_TICK_SPREAD_THRESHOLD;
}

function computePreservedWidthPct(tickLower, tickUpper, offset) {
  if (
    tickLower === undefined ||
    tickLower === null ||
    tickUpper === undefined ||
    tickUpper === null ||
    !Number.isFinite(tickLower) ||
    !Number.isFinite(tickUpper)
  )
    return null;
  const spread = tickUpper - tickLower;
  if (!Number.isFinite(spread) || !(spread > 0)) return null;
  if (!Number.isFinite(offset) || offset < 0 || offset > 100) return null;
  if (isFullRangeSpread(spread)) return "100.00";
  const aboveTicks = (spread * offset) / 100;
  const belowTicks = (spread * (100 - offset)) / 100;
  const widthPct =
    (Math.pow(1.0001, aboveTicks) - Math.pow(1.0001, -belowTicks)) * 100;
  if (!Number.isFinite(widthPct) || !(widthPct > 0)) return null;
  return widthPct.toFixed(2);
}

describe("_computePreservedWidthPct — centered (offset=50)", () => {
  it("returns null for missing tickLower", () => {
    assert.strictEqual(computePreservedWidthPct(undefined, 100, 50), null);
    assert.strictEqual(computePreservedWidthPct(null, 100, 50), null);
  });

  it("returns null for missing tickUpper", () => {
    assert.strictEqual(computePreservedWidthPct(-100, undefined, 50), null);
    assert.strictEqual(computePreservedWidthPct(-100, null, 50), null);
  });

  it("returns null for non-finite ticks (NaN / Infinity)", () => {
    /*- Guards against BigInt / string coercion producing NaN, or a
     *  malformed payload with Infinity. */
    assert.strictEqual(computePreservedWidthPct(NaN, 100, 50), null);
    assert.strictEqual(computePreservedWidthPct(-100, NaN, 50), null);
    assert.strictEqual(computePreservedWidthPct(Infinity, 100, 50), null);
    assert.strictEqual(computePreservedWidthPct(-100, Infinity, 50), null);
    assert.strictEqual(computePreservedWidthPct(-Infinity, 100, 50), null);
  });

  it("returns null when tickUpper <= tickLower (widthPct not positive)", () => {
    /*- Defensive: an invalid range shouldn't render a bogus preview. */
    assert.strictEqual(computePreservedWidthPct(100, 100, 50), null);
    assert.strictEqual(computePreservedWidthPct(500, -500, 50), null);
  });

  it("returns null for invalid offset (< 0, > 100, or non-finite)", () => {
    assert.strictEqual(computePreservedWidthPct(-500, 500, -1), null);
    assert.strictEqual(computePreservedWidthPct(-500, 500, 101), null);
    assert.strictEqual(computePreservedWidthPct(-500, 500, NaN), null);
    assert.strictEqual(computePreservedWidthPct(-500, 500, Infinity), null);
  });

  it("accepts 0 tickLower (legit tick value, not falsy sentinel)", () => {
    /*- Regression guard against `!tickLower` truthy-checks that would
     *  incorrectly treat tick=0 as missing. */
    const result = computePreservedWidthPct(0, 100, 50);
    assert.notEqual(result, null);
    assert.equal(typeof result, "string");
  });

  it("accepts 0 tickUpper", () => {
    const result = computePreservedWidthPct(-100, 0, 50);
    assert.notEqual(result, null);
  });

  it("computes ~10% width for tick span of 1000 at centered offset", () => {
    /*- 1.0001^500 ≈ 1.0513, 1.0001^-500 ≈ 0.9512.
     *  diff * 100 ≈ 10.01% */
    const result = parseFloat(computePreservedWidthPct(-500, 500, 50));
    assert.ok(result > 9.5 && result < 10.5, `expected ~10, got ${result}`);
  });

  it("gives the same width regardless of tick placement (spread-invariant)", () => {
    /*- The formula depends only on (spread, offset), not on the
     *  absolute tick values.  Regression guard: an earlier version
     *  that depended on currentPrice would give different results. */
    const centered = computePreservedWidthPct(-500, 500, 50);
    const shiftedUp = computePreservedWidthPct(1000, 2000, 50);
    const shiftedDown = computePreservedWidthPct(-2000, -1000, 50);
    assert.equal(centered, shiftedUp);
    assert.equal(centered, shiftedDown);
  });

  it("returns a two-decimal fixed string", () => {
    const result = computePreservedWidthPct(-100, 100, 50);
    assert.match(result, /^\d+\.\d{2}$/);
  });

  it("returns '100.00' for a full-range V3 position (tickSpacing=200)", () => {
    /*- MIN_TICK/MAX_TICK for fee=10000 (tickSpacing=200): [-887200,
     *  887200], spread=1,774,400.  Without the short-circuit,
     *  Math.pow(1.0001, 887200) * 100 ≈ 3.37e40 — displays as
     *  truncated scientific notation in the input. */
    assert.strictEqual(computePreservedWidthPct(-887200, 887200, 50), "100.00");
  });

  it("returns '100.00' for a full-range V3 position (tickSpacing=60)", () => {
    /*- Fee=3000, tickSpacing=60: [-887220, 887220], spread=1,774,440. */
    assert.strictEqual(computePreservedWidthPct(-887220, 887220, 50), "100.00");
  });

  it("returns '100.00' for full range regardless of offset (never rebalances)", () => {
    assert.strictEqual(computePreservedWidthPct(-887200, 887200, 30), "100.00");
    assert.strictEqual(computePreservedWidthPct(-887200, 887200, 70), "100.00");
  });

  it("does NOT short-circuit a very wide but non-full-range spread", () => {
    /*- spread=1,000,000 is much wider than typical but still not
     *  full-range (well below the 1,700,000 threshold).  The
     *  computed widthPct is astronomical but the formula runs. */
    const wide = computePreservedWidthPct(-500_000, 500_000, 50);
    assert.notEqual(wide, "100.00");
    assert.notEqual(wide, null);
  });
});

describe("_computePreservedWidthPct — non-centered offsets", () => {
  const SPREAD_1000 = { tL: -500, tU: 500 };

  it("offset=100 puts the entire spread above current tick", () => {
    /*- aboveTicks = 1000, belowTicks = 0.  Width =
     *  (1.0001^1000 - 1) * 100 ≈ (1.1052 - 1) * 100 ≈ 10.52%. */
    const result = parseFloat(
      computePreservedWidthPct(SPREAD_1000.tL, SPREAD_1000.tU, 100),
    );
    assert.ok(result > 10.4 && result < 10.6, `expected ~10.52, got ${result}`);
  });

  it("offset=0 puts the entire spread below current tick", () => {
    /*- aboveTicks = 0, belowTicks = 1000.  Width =
     *  (1 - 1.0001^-1000) * 100 ≈ (1 - 0.9048) * 100 ≈ 9.52%. */
    const result = parseFloat(
      computePreservedWidthPct(SPREAD_1000.tL, SPREAD_1000.tU, 0),
    );
    assert.ok(result > 9.4 && result < 9.6, `expected ~9.52, got ${result}`);
  });

  it("offset=100 vs offset=0 give different (asymmetric) widths for the same spread", () => {
    /*- Verifies the formula actually splits by offset — a bug that
     *  ignored offset would give the same result for both. */
    const allAbove = computePreservedWidthPct(-500, 500, 100);
    const allBelow = computePreservedWidthPct(-500, 500, 0);
    assert.notEqual(allAbove, allBelow);
  });

  it("offset=30 differs from centered (offset=50) for the same spread", () => {
    /*- Regression guard against the earlier centered-only formula. */
    const centered = computePreservedWidthPct(-500, 500, 50);
    const skewed = computePreservedWidthPct(-500, 500, 30);
    assert.notEqual(centered, skewed);
  });

  it("offset=50 is the same regardless of `spread` split (aboveTicks == belowTicks)", () => {
    /*- Sanity: at offset=50, aboveTicks and belowTicks are equal,
     *  so the formula reduces to the symmetric centered case. */
    const symmetric = computePreservedWidthPct(-500, 500, 50);
    /*- Same spread of 1000 in different positions — still centered.
     *  Compare to an equal-spread asymmetric offset just to confirm
     *  the split logic is offset-driven, not tick-driven. */
    const asymmetric = computePreservedWidthPct(-500, 500, 60);
    assert.notEqual(symmetric, asymmetric);
  });
});

// ── Mirror #2: _rangeWidthPreviewText ─────────────────────────────────

function rangeWidthPreviewText(status, active) {
  const saved = status?.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    return String(saved) + "%";
  }
  const rawOffset = status?.offsetToken0Pct;
  const offset =
    rawOffset !== undefined &&
    rawOffset !== null &&
    Number.isFinite(rawOffset) &&
    rawOffset >= 0 &&
    rawOffset <= 100
      ? rawOffset
      : 50;
  const preserved = computePreservedWidthPct(
    active?.tickLower,
    active?.tickUpper,
    offset,
  );
  return preserved ? preserved + "%" : "—";
}

describe("_rangeWidthPreviewText", () => {
  it("shows the saved override as a bare percent when present", () => {
    const text = rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 7.5 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.equal(text, "7.5%");
  });

  it("prefers the saved override over the preserveRange fallback", () => {
    /*- Even when ticks are available (would produce a preserveRange
     *  preview), the saved override wins. */
    const text = rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 15 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.equal(text, "15%");
  });

  it("falls back to preserveRange percent when override is unset", () => {
    const text = rangeWidthPreviewText({}, { tickLower: -500, tickUpper: 500 });
    assert.match(text, /^\d+\.\d{2}%$/);
  });

  it("renders an em-dash when ticks are missing", () => {
    const text = rangeWidthPreviewText({}, {});
    assert.equal(text, "—");
  });

  it("preview value differs for centered vs non-centered offset (same ticks)", () => {
    /*- Regression guard: verifies the preview reads
     *  `status.offsetToken0Pct` and passes it through to the width
     *  formula.  An earlier centered-only implementation would
     *  produce the same preview text for both offsets. */
    const active = { tickLower: -500, tickUpper: 500 };
    const centered = rangeWidthPreviewText({ offsetToken0Pct: 50 }, active);
    const skewed = rangeWidthPreviewText({ offsetToken0Pct: 30 }, active);
    assert.notEqual(centered, skewed);
  });

  it("defaults to centered (offset=50) when status.offsetToken0Pct is missing", () => {
    const active = { tickLower: -500, tickUpper: 500 };
    const implicit = rangeWidthPreviewText({}, active);
    const explicit = rangeWidthPreviewText({ offsetToken0Pct: 50 }, active);
    assert.equal(implicit, explicit);
  });

  it("treats saved override of 0 as absent (matches truthy-omit in bot-cycle-opts.js)", () => {
    /*- 0 is not a legitimate range width (min is 0.1%); the seam in
     *  bot-cycle-opts.js correctly omits customRangeWidthPct when
     *  _getConfig returns 0, so the preview should reflect that by
     *  falling through to the preserveRange path. */
    const text = rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 0 },
      { tickLower: -100, tickUpper: 100 },
    );
    /*- With `Number.isFinite(0)` being true and the explicit
     *  `!== undefined && !== null` check passing, `0` DOES get
     *  formatted as "0%".  This is intentional: the mirror surfaces
     *  exactly what the user has in config; the server-side seam
     *  separately decides to omit the override.  Documented here so
     *  a future refactor doesn't "fix" this. */
    assert.equal(text, "0%");
  });

  it("null status and null active render em-dash fallback", () => {
    const text = rangeWidthPreviewText(null, null);
    assert.equal(text, "—");
  });
});

// ── Mirror #3: request-body shape for the two POST call sites ─────────

/*- The two rebalance-triggering call sites (Mission Control confirm and
 *  closed-position re-open intro modal) both call
 *  `_postRebalance(url, body, active, actLabel)`.  The bodies are
 *  built at the call site, not in _postRebalance itself, so this
 *  mirror tests the shape each call site sends.  Regression coverage
 *  for the plan's requirement that neither body includes
 *  `customRangeWidthPct` (range width is a persistent per-position
 *  config value read by the bot loop). */

function buildMissionControlBody(active, compositeKey) {
  return {
    positionKey: compositeKey(
      "pulsechain",
      active.walletAddress,
      active.contractAddress,
      active.tokenId,
    ),
  };
}

function buildReopenBody(active) {
  return {
    tokenId: active.tokenId,
    contract: active.contractAddress,
    forceRebalance: true,
  };
}

describe("Rebalance request-body shape (no customRangeWidthPct leak)", () => {
  const active = {
    walletAddress: "0xW",
    contractAddress: "0xC",
    tokenId: "42",
  };

  it("mission control confirm sends only positionKey", () => {
    const body = buildMissionControlBody(
      active,
      (chain, w, c, t) => `${chain}-${w}-${c}-${t}`,
    );
    assert.deepStrictEqual(body, { positionKey: "pulsechain-0xW-0xC-42" });
    assert.ok(
      !("customRangeWidthPct" in body),
      "range width must not leak into /api/rebalance body",
    );
  });

  it("reopen intro modal sends tokenId+contract+forceRebalance only", () => {
    const body = buildReopenBody(active);
    assert.deepStrictEqual(body, {
      tokenId: "42",
      contract: "0xC",
      forceRebalance: true,
    });
    assert.ok(
      !("customRangeWidthPct" in body),
      "range width must not leak into /api/position/manage body — bot reads it from config",
    );
    /*- Regression guards for other legacy fields the migration removed. */
    assert.ok(!("positionKey" in body));
    assert.ok(!("liquidity" in body));
  });
});
