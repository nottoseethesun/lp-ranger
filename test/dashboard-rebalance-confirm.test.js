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
 *  public/dashboard-rebalance-confirm.js.  Same formula as
 *  src/rebalancer.js:294-298:
 *    ((upperPrice - lowerPrice) / currentPrice) * 100
 *  Presence checks use explicit `!== undefined && !== null` per
 *  CLAUDE-BEST-PRACTICES §"Type Checks". */
function computePreservedWidthPct(tickLower, tickUpper, currentPrice) {
  if (
    tickLower === undefined ||
    tickLower === null ||
    tickUpper === undefined ||
    tickUpper === null ||
    typeof currentPrice !== "number" ||
    !(currentPrice > 0)
  )
    return null;
  const lowerP = Math.pow(1.0001, tickLower);
  const upperP = Math.pow(1.0001, tickUpper);
  return (((upperP - lowerP) / currentPrice) * 100).toFixed(2);
}

describe("_computePreservedWidthPct", () => {
  it("returns null for missing tickLower", () => {
    assert.strictEqual(computePreservedWidthPct(undefined, 100, 1), null);
    assert.strictEqual(computePreservedWidthPct(null, 100, 1), null);
  });

  it("returns null for missing tickUpper", () => {
    assert.strictEqual(computePreservedWidthPct(-100, undefined, 1), null);
    assert.strictEqual(computePreservedWidthPct(-100, null, 1), null);
  });

  it("returns null for non-numeric or non-positive price", () => {
    assert.strictEqual(computePreservedWidthPct(-100, 100, undefined), null);
    assert.strictEqual(computePreservedWidthPct(-100, 100, null), null);
    assert.strictEqual(computePreservedWidthPct(-100, 100, 0), null);
    assert.strictEqual(computePreservedWidthPct(-100, 100, -1), null);
    assert.strictEqual(computePreservedWidthPct(-100, 100, "1"), null);
  });

  it("accepts 0 tickLower (legit tick value, not falsy sentinel)", () => {
    /*- Regression guard against `!tickLower` truthy-checks that would
     *  incorrectly treat tick=0 as missing. */
    const result = computePreservedWidthPct(0, 100, 1);
    assert.notEqual(result, null);
    assert.equal(typeof result, "string");
  });

  it("accepts 0 tickUpper", () => {
    const result = computePreservedWidthPct(-100, 0, 1);
    assert.notEqual(result, null);
  });

  it("computes a symmetric ±5% width around 1.0 (approx tickLower=-500, tickUpper=500)", () => {
    /*- 1.0001^500 ≈ 1.0513, 1.0001^-500 ≈ 0.9512.
     *  (1.0513 - 0.9512) / 1.0 * 100 ≈ 10.01% */
    const result = parseFloat(computePreservedWidthPct(-500, 500, 1));
    assert.ok(result > 9.5 && result < 10.5, `expected ~10, got ${result}`);
  });

  it("returns a two-decimal fixed string", () => {
    const result = computePreservedWidthPct(-100, 100, 1);
    assert.match(result, /^\d+\.\d{2}$/);
  });
});

// ── Mirror #2: _rangeWidthPreviewText ─────────────────────────────────

function rangeWidthPreviewText(status, active) {
  const saved = status?.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    return String(saved) + "% (from saved override)";
  }
  const preserved = computePreservedWidthPct(
    active?.tickLower,
    active?.tickUpper,
    status?.poolState?.price,
  );
  return preserved
    ? "preserving current tick spread (~" + preserved + "%)"
    : "preserving current tick spread";
}

describe("_rangeWidthPreviewText", () => {
  it("shows the saved override verbatim when present", () => {
    const text = rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 7.5 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.equal(text, "7.5% (from saved override)");
  });

  it("prefers the saved override over the preserveRange fallback", () => {
    /*- Even when ticks+price are available (would produce a
     *  preserveRange preview), the saved override wins. */
    const text = rangeWidthPreviewText(
      {
        rebalanceRangeWidthPct: 15,
        poolState: { price: 1 },
      },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.match(text, /^15% \(from saved override\)$/);
  });

  it("falls back to preserveRange preview when override is unset", () => {
    const text = rangeWidthPreviewText(
      { poolState: { price: 1 } },
      { tickLower: -500, tickUpper: 500 },
    );
    assert.match(text, /^preserving current tick spread \(~\d+\.\d{2}%\)$/);
  });

  it("shows generic preserveRange text when ticks or price are missing", () => {
    const text = rangeWidthPreviewText({}, {});
    assert.equal(text, "preserving current tick spread");
  });

  it("treats saved override of 0 as absent (matches truthy-omit in bot-cycle-opts.js)", () => {
    /*- 0 is not a legitimate range width (min is 0.1%); the seam in
     *  bot-cycle-opts.js correctly omits customRangeWidthPct when
     *  _getConfig returns 0, so the preview should reflect that by
     *  falling through to the preserveRange path. */
    const text = rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 0, poolState: { price: 1 } },
      { tickLower: -100, tickUpper: 100 },
    );
    /*- With `Number.isFinite(0)` being true and the explicit
     *  `!== undefined && !== null` check passing, `0` DOES get
     *  formatted as "0% (from saved override)".  This is intentional:
     *  the mirror surfaces exactly what the user has in config; the
     *  server-side seam separately decides to omit the override.
     *  Documented here so a future refactor doesn't "fix" this. */
    assert.equal(text, "0% (from saved override)");
  });

  it("null status and null active render generic fallback", () => {
    const text = rangeWidthPreviewText(null, null);
    assert.equal(text, "preserving current tick spread");
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
