/**
 * @file test/dashboard-data-range-width.test.js
 * @description Mirror tests for `syncRangeWidth` and
 * `syncFullRangeCheckbox` in `public/dashboard-data-range-width.js`.
 * The dashboard module pulls DOM + a browser-only ES-module import
 * graph that node:test can't load, so we mirror the functions here in
 * plain CommonJS with lightweight DOM/posStore stubs and cover the
 * end-to-end flows at the logic level.  Same pattern as
 * `test/dashboard-mixed-state-fix.test.js`.
 *
 * Behavior under test (post the "Range Width" → "Price Range
 * Extension" rename + no-fallback-when-unset rework):
 *
 *   syncRangeWidth:
 *     - saved override present → populate input (rounded to 2 decimals)
 *     - no saved override → input stays empty; no computed fallback
 *     - position switch → clear input if no saved override
 *     - mid-typing (isDirty) → skip
 *
 *   syncFullRangeCheckbox:
 *     - `data.fullRangeRebalanceEnabled === true` → checkbox checked
 *     - `data.fullRangeRebalanceEnabled === false` → checkbox unchecked
 *     - unset/null → checkbox reflects on-chain reality (full-range spread)
 *     - checked → Price Range Extension input is disabled
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ── Test doubles ──────────────────────────────────────────────────────

/** Minimal DOM double for a single input element. */
function makeInput(initialValue = "") {
  return { value: initialValue, disabled: false };
}

/** Minimal DOM double for a checkbox element. */
function makeCheckbox(initialChecked = false) {
  return { checked: initialChecked };
}

/*- Mirror of dashboard-helpers.js:isFullRangeSpread. */
const FULL_RANGE_TICK_SPREAD_THRESHOLD = 1_700_000;
function isFullRangeSpread(spread) {
  return Number.isFinite(spread) && spread >= FULL_RANGE_TICK_SPREAD_THRESHOLD;
}

/*- Mirror of the production `syncRangeWidth` — takes injected
 *  dependencies (`el`, `posKeyRef`, `isDirty`, `state`) instead of
 *  importing DOM/posStore/isInputDirty. */
function makeSyncRangeWidth() {
  let _lastKnownPosKey = null;
  return function syncRangeWidth(data, ctx) {
    const { el, isDirty, posKey } = ctx;
    if (!el) return;
    if (isDirty) return;
    if (!posKey) return;
    const isNewPosition = _lastKnownPosKey !== posKey;
    const saved = data.rebalanceRangeWidthPct;
    if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
      if (isNewPosition || el.value === "") el.value = saved.toFixed(2);
      _lastKnownPosKey = posKey;
      return;
    }
    if (isNewPosition) el.value = "";
    _lastKnownPosKey = posKey;
  };
}

/*- Mirror of the production `_isActivePositionFullRange`. */
function isActivePositionFullRange(data) {
  const ap = data.activePosition;
  const active = data._active;
  const tL = ap?.tickLower ?? active?.tickLower;
  const tU = ap?.tickUpper ?? active?.tickUpper;
  if (tL === undefined || tL === null || tU === undefined || tU === null)
    return false;
  if (!Number.isFinite(tL) || !Number.isFinite(tU)) return false;
  return isFullRangeSpread(tU - tL);
}

/*- Mirror of the production `syncFullRangeCheckbox`. */
function syncFullRangeCheckbox(data, ctx) {
  const { chk, input } = ctx;
  if (!chk) return;
  const saved = data.fullRangeRebalanceEnabled;
  let checked;
  if (typeof saved === "boolean") {
    checked = saved;
  } else {
    checked = isActivePositionFullRange(data);
  }
  chk.checked = checked;
  if (input) input.disabled = checked;
}

// ── syncRangeWidth: saved override present ────────────────────────────

describe("syncRangeWidth — saved override present", () => {
  it("populates input with rebalanceRangeWidthPct on position switch", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "25.00");
  });

  it("rounds saved override to 2 decimals", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: 25.6789 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "25.68");
  });

  it("does not clobber user's typed value when input already populated", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    /*- First call: fresh position, populate. */
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    /*- Simulate user typing over the value. */
    el.value = "42";
    /*- Second poll on same position, input non-empty → skip. */
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "42");
  });

  it("respects the dirty flag mid-typing", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: true, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "");
  });

  it("re-populates on position switch when input was empty", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    el.value = "";
    sync(
      { rebalanceRangeWidthPct: 50 },
      { el, isDirty: false, posKey: "TOKEN_B" },
    );
    assert.strictEqual(el.value, "50.00");
  });
});

// ── syncRangeWidth: no saved override → empty input ───────────────────

describe("syncRangeWidth — no saved override", () => {
  it("leaves input empty when rebalanceRangeWidthPct is null", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: null },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "");
  });

  it("leaves input empty when rebalanceRangeWidthPct is undefined", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync({}, { el, isDirty: false, posKey: "TOKEN_A" });
    assert.strictEqual(el.value, "");
  });

  it("does NOT compute a fallback from position ticks (regression guard)", () => {
    /*- Prior behavior computed a widthPct from the position's tick
     *  spread + offset; that was misleading — it looked like a saved
     *  value.  This test guards against it coming back. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      {
        activePosition: {
          tickLower: -2500,
          tickUpper: 2500,
        },
        offsetToken0Pct: 50,
      },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "");
  });

  it("clears input on position switch when new position has no saved value", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(
      { rebalanceRangeWidthPct: 25 },
      { el, isDirty: false, posKey: "TOKEN_A" },
    );
    assert.strictEqual(el.value, "25.00");
    sync({}, { el, isDirty: false, posKey: "TOKEN_B" });
    assert.strictEqual(el.value, "");
  });
});

// ── syncFullRangeCheckbox: explicit saved flag ────────────────────────

describe("syncFullRangeCheckbox — explicit saved flag", () => {
  it("checks the box when fullRangeRebalanceEnabled === true", () => {
    const chk = makeCheckbox(false);
    const input = makeInput("");
    syncFullRangeCheckbox({ fullRangeRebalanceEnabled: true }, { chk, input });
    assert.strictEqual(chk.checked, true);
    assert.strictEqual(input.disabled, true);
  });

  it("unchecks the box when fullRangeRebalanceEnabled === false", () => {
    const chk = makeCheckbox(true);
    const input = makeInput("");
    syncFullRangeCheckbox({ fullRangeRebalanceEnabled: false }, { chk, input });
    assert.strictEqual(chk.checked, false);
    assert.strictEqual(input.disabled, false);
  });

  it("explicit false wins over full-range on-chain state", () => {
    /*- A user who's explicitly opted OUT of full-range rebalancing
     *  should stay opted out even if their current NFT happens to be
     *  full-range on-chain. */
    const chk = makeCheckbox(false);
    const input = makeInput("");
    syncFullRangeCheckbox(
      {
        fullRangeRebalanceEnabled: false,
        activePosition: {
          tickLower: -887272,
          tickUpper: 887272,
        },
      },
      { chk, input },
    );
    assert.strictEqual(chk.checked, false);
    assert.strictEqual(input.disabled, false);
  });
});

// ── syncFullRangeCheckbox: unset → reflect on-chain reality ───────────

describe("syncFullRangeCheckbox — unset saved flag", () => {
  it("checks the box when the current position is full-range on-chain", () => {
    const chk = makeCheckbox(false);
    const input = makeInput("");
    syncFullRangeCheckbox(
      {
        activePosition: {
          tickLower: -887272,
          tickUpper: 887272,
        },
      },
      { chk, input },
    );
    assert.strictEqual(chk.checked, true);
    assert.strictEqual(input.disabled, true);
  });

  it("unchecks the box when the current position is NOT full-range", () => {
    const chk = makeCheckbox(true);
    const input = makeInput("");
    syncFullRangeCheckbox(
      {
        activePosition: {
          tickLower: -2500,
          tickUpper: 2500,
        },
      },
      { chk, input },
    );
    assert.strictEqual(chk.checked, false);
    assert.strictEqual(input.disabled, false);
  });

  it("falls back to posStore when data.activePosition is missing", () => {
    const chk = makeCheckbox(false);
    const input = makeInput("");
    syncFullRangeCheckbox(
      {
        _active: {
          tickLower: -887272,
          tickUpper: 887272,
        },
      },
      { chk, input },
    );
    assert.strictEqual(chk.checked, true);
    assert.strictEqual(input.disabled, true);
  });

  it("stays unchecked when no ticks are available", () => {
    const chk = makeCheckbox(false);
    const input = makeInput("");
    syncFullRangeCheckbox({}, { chk, input });
    assert.strictEqual(chk.checked, false);
    assert.strictEqual(input.disabled, false);
  });
});
