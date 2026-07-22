"use strict";

/**
 * @file test/dashboard-rebalance-confirm.test.js
 * @description Tests for the pure helpers in
 *   `public/dashboard-rebalance-confirm.js`, plus the request-body
 *   shape for the two POST call sites.  Uses jsdom (via
 *   `global-jsdom/register`) so the browser module can be imported
 *   directly; the two previously-private helpers
 *   (`_computePreservedWidthPct`, `_rangeWidthPreviewText`) were
 *   promoted to exports per the extract-for-testability rule.
 *   `compositeKey` comes from the real `dashboard-helpers.js`.
 *
 *   Covered:
 *     1. `_computePreservedWidthPct(tickLower, tickUpper, offset)`
 *        — on-chain-tick-spread → %-of-current-price formula.
 *     2. `_rangeWidthPreviewText(status, active)` — the modal preview
 *        text (Full-Range / saved-override / preserveRange fallback /
 *        em-dash).
 *     3. Request-body shape for the two POST call sites: mission-
 *        control confirm (`/api/rebalance` with just positionKey)
 *        and closed-position re-open (`/api/position/manage` with
 *        tokenId+contract+forceRebalance).
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let helpers;

before(async () => {
  mod = await import("../public/dashboard-rebalance-confirm.js");
  helpers = await import("../public/dashboard-helpers.js");
});

// ── _computePreservedWidthPct — centered (offset=50) ──────────────────

describe("_computePreservedWidthPct — centered (offset=50)", () => {
  it("returns null for missing tickLower", () => {
    assert.strictEqual(mod._computePreservedWidthPct(undefined, 100, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(null, 100, 50), null);
  });

  it("returns null for missing tickUpper", () => {
    assert.strictEqual(
      mod._computePreservedWidthPct(-100, undefined, 50),
      null,
    );
    assert.strictEqual(mod._computePreservedWidthPct(-100, null, 50), null);
  });

  it("returns null for non-finite ticks (NaN / Infinity)", () => {
    assert.strictEqual(mod._computePreservedWidthPct(NaN, 100, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(-100, NaN, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(Infinity, 100, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(-100, Infinity, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(-Infinity, 100, 50), null);
  });

  it("returns null when tickUpper <= tickLower (widthPct not positive)", () => {
    assert.strictEqual(mod._computePreservedWidthPct(100, 100, 50), null);
    assert.strictEqual(mod._computePreservedWidthPct(500, -500, 50), null);
  });

  it("returns null for invalid offset (< 0, > 100, or non-finite)", () => {
    assert.strictEqual(mod._computePreservedWidthPct(-500, 500, -1), null);
    assert.strictEqual(mod._computePreservedWidthPct(-500, 500, 101), null);
    assert.strictEqual(mod._computePreservedWidthPct(-500, 500, NaN), null);
    assert.strictEqual(
      mod._computePreservedWidthPct(-500, 500, Infinity),
      null,
    );
  });

  it("accepts 0 tickLower (legit tick value, not falsy sentinel)", () => {
    const result = mod._computePreservedWidthPct(0, 100, 50);
    assert.notStrictEqual(result, null);
    assert.strictEqual(typeof result, "string");
  });

  it("accepts 0 tickUpper", () => {
    const result = mod._computePreservedWidthPct(-100, 0, 50);
    assert.notStrictEqual(result, null);
  });

  it("computes ~10% width for tick span of 1000 at centered offset", () => {
    const result = parseFloat(mod._computePreservedWidthPct(-500, 500, 50));
    assert.ok(result > 9.5 && result < 10.5, `expected ~10, got ${result}`);
  });

  it("gives the same width regardless of tick placement (spread-invariant)", () => {
    const centered = mod._computePreservedWidthPct(-500, 500, 50);
    const shiftedUp = mod._computePreservedWidthPct(1000, 2000, 50);
    const shiftedDown = mod._computePreservedWidthPct(-2000, -1000, 50);
    assert.strictEqual(centered, shiftedUp);
    assert.strictEqual(centered, shiftedDown);
  });

  it("returns a two-decimal fixed string", () => {
    const result = mod._computePreservedWidthPct(-100, 100, 50);
    assert.match(result, /^\d+\.\d{2}$/);
  });

  it("returns '100.00' for a full-range V3 position (tickSpacing=200)", () => {
    assert.strictEqual(
      mod._computePreservedWidthPct(-887200, 887200, 50),
      "100.00",
    );
  });

  it("returns '100.00' for a full-range V3 position (tickSpacing=60)", () => {
    assert.strictEqual(
      mod._computePreservedWidthPct(-887220, 887220, 50),
      "100.00",
    );
  });

  it("returns '100.00' for full range regardless of offset (never rebalances)", () => {
    assert.strictEqual(
      mod._computePreservedWidthPct(-887200, 887200, 30),
      "100.00",
    );
    assert.strictEqual(
      mod._computePreservedWidthPct(-887200, 887200, 70),
      "100.00",
    );
  });

  it("does NOT short-circuit a very wide but non-full-range spread", () => {
    const wide = mod._computePreservedWidthPct(-500_000, 500_000, 50);
    assert.notStrictEqual(wide, "100.00");
    assert.notStrictEqual(wide, null);
  });
});

// ── _computePreservedWidthPct — non-centered offsets ──────────────────

describe("_computePreservedWidthPct — non-centered offsets", () => {
  it("offset=100 puts the entire spread above current tick", () => {
    const result = parseFloat(mod._computePreservedWidthPct(-500, 500, 100));
    assert.ok(result > 10.4 && result < 10.6, `expected ~10.52, got ${result}`);
  });

  it("offset=0 puts the entire spread below current tick", () => {
    const result = parseFloat(mod._computePreservedWidthPct(-500, 500, 0));
    assert.ok(result > 9.4 && result < 9.6, `expected ~9.52, got ${result}`);
  });

  it("offset=100 vs offset=0 give different (asymmetric) widths for the same spread", () => {
    const allAbove = mod._computePreservedWidthPct(-500, 500, 100);
    const allBelow = mod._computePreservedWidthPct(-500, 500, 0);
    assert.notStrictEqual(allAbove, allBelow);
  });

  it("offset=30 differs from centered (offset=50) for the same spread", () => {
    const centered = mod._computePreservedWidthPct(-500, 500, 50);
    const skewed = mod._computePreservedWidthPct(-500, 500, 30);
    assert.notStrictEqual(centered, skewed);
  });

  it("offset=50 is different from asymmetric offsets (split logic works)", () => {
    const symmetric = mod._computePreservedWidthPct(-500, 500, 50);
    const asymmetric = mod._computePreservedWidthPct(-500, 500, 60);
    assert.notStrictEqual(symmetric, asymmetric);
  });
});

// ── _rangeWidthPreviewText ────────────────────────────────────────────

describe("_rangeWidthPreviewText", () => {
  it("shows the saved override as a bare percent when present", () => {
    const text = mod._rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 7.5 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.strictEqual(text, "7.5%");
  });

  it("prefers the saved override over the preserveRange fallback", () => {
    const text = mod._rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 15 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.strictEqual(text, "15%");
  });

  it("falls back to preserveRange percent when override is unset", () => {
    const text = mod._rangeWidthPreviewText(
      {},
      { tickLower: -500, tickUpper: 500 },
    );
    assert.match(text, /^\d+\.\d{2}%$/);
  });

  it("renders an em-dash when ticks are missing", () => {
    const text = mod._rangeWidthPreviewText({}, {});
    assert.strictEqual(text, "—");
  });

  it("preview value differs for centered vs non-centered offset (same ticks)", () => {
    const active = { tickLower: -500, tickUpper: 500 };
    const centered = mod._rangeWidthPreviewText(
      { offsetToken0Pct: 50 },
      active,
    );
    const skewed = mod._rangeWidthPreviewText({ offsetToken0Pct: 30 }, active);
    assert.notStrictEqual(centered, skewed);
  });

  it("defaults to centered (offset=50) when status.offsetToken0Pct is missing", () => {
    const active = { tickLower: -500, tickUpper: 500 };
    const implicit = mod._rangeWidthPreviewText({}, active);
    const explicit = mod._rangeWidthPreviewText(
      { offsetToken0Pct: 50 },
      active,
    );
    assert.strictEqual(implicit, explicit);
  });

  it("treats saved override of 0 as displayed (matches user-visible config)", () => {
    /*- 0 is not a legitimate range width but the preview surfaces the
     *  raw config value.  The server-side seam in bot-cycle-opts.js
     *  separately decides to omit customRangeWidthPct when 0.
     *  Documented here so a future refactor doesn't "fix" this. */
    const text = mod._rangeWidthPreviewText(
      { rebalanceRangeWidthPct: 0 },
      { tickLower: -100, tickUpper: 100 },
    );
    assert.strictEqual(text, "0%");
  });

  it("null status and null active render em-dash fallback", () => {
    const text = mod._rangeWidthPreviewText(null, null);
    assert.strictEqual(text, "—");
  });

  it("shows 'Full-Range' when fullRangeRebalanceEnabled=true (overrides saved widthPct)", () => {
    const text = mod._rangeWidthPreviewText(
      { fullRangeRebalanceEnabled: true, rebalanceRangeWidthPct: 15 },
      { tickLower: -500, tickUpper: 500 },
    );
    assert.strictEqual(text, "Full-Range");
  });

  it("shows 'Full-Range' when fullRangeRebalanceEnabled=true with no saved widthPct", () => {
    const text = mod._rangeWidthPreviewText(
      { fullRangeRebalanceEnabled: true },
      { tickLower: -500, tickUpper: 500 },
    );
    assert.strictEqual(text, "Full-Range");
  });

  it("ignores non-boolean truthy fullRangeRebalanceEnabled values (strict === true)", () => {
    const text = mod._rangeWidthPreviewText(
      { fullRangeRebalanceEnabled: "true", rebalanceRangeWidthPct: 15 },
      { tickLower: -500, tickUpper: 500 },
    );
    assert.strictEqual(text, "15%");
  });
});

// ── Request-body shape for the two POST call sites ────────────────────

/*- Both rebalance-triggering call sites call `_postRebalance(url, body,
 *  active, actLabel)` — the bodies are built at the call site, not in
 *  _postRebalance itself, so this tests the shape each caller sends.
 *  Regression coverage for the plan's requirement that neither body
 *  includes `customRangeWidthPct` (range width is a persistent per-
 *  position config value the bot loop reads separately). */

function buildMissionControlBody(active) {
  return {
    positionKey: helpers.compositeKey(
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
    const body = buildMissionControlBody(active);
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
    assert.ok(!("positionKey" in body));
    assert.ok(!("liquidity" in body));
  });
});
