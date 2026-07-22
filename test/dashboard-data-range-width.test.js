"use strict";

/**
 * @file test/dashboard-data-range-width.test.js
 * @description Tests the pure decisions extracted from
 *   `syncRangeWidth` and `syncFullRangeCheckbox` in
 *   `public/dashboard-data-range-width.js`:
 *
 *     - `computeRangeWidthDecision(data, ctx)`
 *     - `computeFullRangeChecked(data, activeFromStore)`
 *     - `isActivePositionFullRange(activeFromPayload, activeFromStore)`
 *
 *   Extraction (over the previous inline-in-syncRangeWidth logic)
 *   removes the mirror-drift risk that the previous test file inherited:
 *   the tests now target the real exports so any behavioural change to
 *   the sync path is caught immediately.
 *
 *   Contract:
 *     syncRangeWidth:
 *       - saved override present → populate input (rounded to 2 decimals)
 *       - no saved override → input stays empty; no computed fallback
 *       - position switch → clear input if no saved override
 *       - mid-typing (isDirty) → skip
 *     syncFullRangeCheckbox:
 *       - `data.fullRangeRebalanceEnabled === true` → checkbox checked
 *       - `data.fullRangeRebalanceEnabled === false` → checkbox unchecked
 *       - unset/null → checkbox reflects on-chain reality (full-range spread)
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-data-range-width.js");
});

// ── computeRangeWidthDecision ─────────────────────────────────────────

describe("computeRangeWidthDecision()", () => {
  it("saved override → write on new position (rounded to 2 decimals)", () => {
    const r = mod.computeRangeWidthDecision(
      { rebalanceRangeWidthPct: 8 },
      {
        posKey: "100",
        lastKnownPosKey: null,
        currentValue: "",
        isDirty: false,
      },
    );
    assert.strictEqual(r.shouldWrite, true);
    assert.strictEqual(r.newValue, "8.00");
    assert.strictEqual(r.newLastKnownPosKey, "100");
  });

  it("saved override → write on same-position when input is empty", () => {
    const r = mod.computeRangeWidthDecision(
      { rebalanceRangeWidthPct: 12.5 },
      {
        posKey: "100",
        lastKnownPosKey: "100",
        currentValue: "",
        isDirty: false,
      },
    );
    assert.strictEqual(r.shouldWrite, true);
    assert.strictEqual(r.newValue, "12.50");
  });

  it("saved override → skip on same-position when input has value (mid-typing preservation)", () => {
    const r = mod.computeRangeWidthDecision(
      { rebalanceRangeWidthPct: 8 },
      {
        posKey: "100",
        lastKnownPosKey: "100",
        currentValue: "5",
        isDirty: false,
      },
    );
    assert.strictEqual(r.shouldWrite, false);
    assert.strictEqual(r.newLastKnownPosKey, "100");
  });

  it("no saved override → clear on new position", () => {
    const r = mod.computeRangeWidthDecision(
      {},
      {
        posKey: "100",
        lastKnownPosKey: null,
        currentValue: "5",
        isDirty: false,
      },
    );
    assert.strictEqual(r.shouldWrite, true);
    assert.strictEqual(r.newValue, "");
    assert.strictEqual(r.newLastKnownPosKey, "100");
  });

  it("no saved override → skip on same position", () => {
    const r = mod.computeRangeWidthDecision(
      {},
      {
        posKey: "100",
        lastKnownPosKey: "100",
        currentValue: "",
        isDirty: false,
      },
    );
    assert.strictEqual(r.shouldWrite, false);
    assert.strictEqual(r.newLastKnownPosKey, "100");
  });

  it("isDirty → skip everything (mid-typing guard)", () => {
    const r = mod.computeRangeWidthDecision(
      { rebalanceRangeWidthPct: 99 },
      {
        posKey: "100",
        lastKnownPosKey: null,
        currentValue: "5",
        isDirty: true,
      },
    );
    assert.strictEqual(r.shouldWrite, false);
    assert.strictEqual(r.newLastKnownPosKey, undefined);
  });

  it("no posKey → skip everything (guard before pos change detection)", () => {
    const r = mod.computeRangeWidthDecision(
      { rebalanceRangeWidthPct: 8 },
      { posKey: null, lastKnownPosKey: null, currentValue: "", isDirty: false },
    );
    assert.strictEqual(r.shouldWrite, false);
    assert.strictEqual(r.newLastKnownPosKey, undefined);
  });

  it("rejects non-finite saved values (Infinity, NaN) as if unset", () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
      const r = mod.computeRangeWidthDecision(
        { rebalanceRangeWidthPct: bad },
        {
          posKey: "100",
          lastKnownPosKey: "100",
          currentValue: "",
          isDirty: false,
        },
      );
      assert.strictEqual(
        r.shouldWrite,
        false,
        `bad value ${bad} should not trigger a write when same-pos + empty`,
      );
    }
  });
});

// ── computeFullRangeChecked ───────────────────────────────────────────

describe("computeFullRangeChecked()", () => {
  it("data.fullRangeRebalanceEnabled === true → checked (ignores on-chain reality)", () => {
    assert.strictEqual(
      mod.computeFullRangeChecked({ fullRangeRebalanceEnabled: true }, null),
      true,
    );
  });

  it("data.fullRangeRebalanceEnabled === false → unchecked", () => {
    assert.strictEqual(
      mod.computeFullRangeChecked(
        {
          fullRangeRebalanceEnabled: false,
          activePosition: { tickLower: -887200, tickUpper: 887200 },
        },
        null,
      ),
      false,
    );
  });

  it("unset → reflects on-chain reality (full-range spread from payload)", () => {
    assert.strictEqual(
      mod.computeFullRangeChecked(
        {
          activePosition: { tickLower: -887200, tickUpper: 887200 },
        },
        null,
      ),
      true,
    );
  });

  it("unset + narrow-range → unchecked", () => {
    assert.strictEqual(
      mod.computeFullRangeChecked(
        {
          activePosition: { tickLower: -100, tickUpper: 100 },
        },
        null,
      ),
      false,
    );
  });

  it("payload ticks missing → falls back to posStore active-entry ticks", () => {
    assert.strictEqual(
      mod.computeFullRangeChecked(
        { activePosition: {} },
        { tickLower: -887200, tickUpper: 887200 },
      ),
      true,
    );
  });
});

// ── isActivePositionFullRange ─────────────────────────────────────────

describe("isActivePositionFullRange()", () => {
  it("is true for the canonical V3 full-range ticks (±887272)", () => {
    assert.strictEqual(
      mod.isActivePositionFullRange(
        { tickLower: -887200, tickUpper: 887200 },
        null,
      ),
      true,
    );
  });

  it("is false when ticks are undefined / null", () => {
    assert.strictEqual(mod.isActivePositionFullRange({}, {}), false);
    assert.strictEqual(mod.isActivePositionFullRange(null, null), false);
  });

  it("is false when ticks are not finite", () => {
    assert.strictEqual(
      mod.isActivePositionFullRange(
        { tickLower: NaN, tickUpper: 887200 },
        null,
      ),
      false,
    );
  });

  it("prefers payload ticks over posStore ticks", () => {
    // Payload says narrow, store says wide → uses payload → false.
    assert.strictEqual(
      mod.isActivePositionFullRange(
        { tickLower: -100, tickUpper: 100 },
        { tickLower: -887200, tickUpper: 887200 },
      ),
      false,
    );
  });
});
