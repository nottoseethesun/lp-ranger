/**
 * @file test/dashboard-data-range-width.test.js
 * @description Mirror tests for `syncRangeWidth` in
 * `public/dashboard-data-range-width.js`.  The dashboard module pulls
 * DOM + localStorage + a browser-only ES-module import graph that
 * node:test can't load, so we mirror the function here in plain
 * CommonJS with lightweight DOM/posStore stubs and cover the
 * end-to-end flows at the logic level.  Same pattern as
 * `test/dashboard-mixed-state-fix.test.js`.
 *
 * The flows covered here match the end-to-end paths audited during
 * the "Migrate Rebalance UI dialog into Bot Settings" plan:
 *   (a) bring position under management
 *   (b) unmanage → browse elsewhere → browse back → Manage
 *   (c),(d) closed-position reopen (posKey migrates to a new tokenId)
 *   (e) no LP positions on wallet
 *   (f) app starts on a closed position
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ── Test doubles ──────────────────────────────────────────────────────

/** Minimal DOM double for a single input element. */
function makeInput(initialValue = "") {
  return { value: initialValue };
}

/*- Shared width-from-(spread, offset) formula used by all three
 *  mirror helpers below.  Matches
 *  `src/range-math.js:preserveRange()` split. */
function widthWithOffset(spread, offset) {
  if (!Number.isFinite(spread) || !(spread > 0)) return null;
  if (!Number.isFinite(offset) || offset < 0 || offset > 100) return null;
  const aboveTicks = (spread * offset) / 100;
  const belowTicks = (spread * (100 - offset)) / 100;
  const widthPct =
    (Math.pow(1.0001, aboveTicks) - Math.pow(1.0001, -belowTicks)) * 100;
  if (!Number.isFinite(widthPct) || !(widthPct > 0)) return null;
  return widthPct.toFixed(2);
}

/*- Resolve offset from `data` / `ctx` — falls back to 50 (centered)
 *  when missing / invalid. */
function resolveOffset(raw) {
  if (
    raw !== undefined &&
    raw !== null &&
    Number.isFinite(raw) &&
    raw >= 0 &&
    raw <= 100
  )
    return raw;
  return 50;
}

/*- Extract a positive tick spread from `data.activePosition`.  Null
 *  if ticks are missing / non-finite / non-positive spread. */
function resolveSpread(data) {
  const ap = data.activePosition;
  const tL = ap?.tickLower;
  const tU = ap?.tickUpper;
  if (
    tL === undefined ||
    tL === null ||
    tU === undefined ||
    tU === null ||
    !Number.isFinite(tL) ||
    !Number.isFinite(tU)
  )
    return null;
  const spread = tU - tL;
  return Number.isFinite(spread) && spread > 0 ? spread : null;
}

/*- Mirror of the production `_computeFallbackWidthPct` — pure
 *  function of (spread, offset). */
function computeFallbackWidthPct(data) {
  const spread = resolveSpread(data);
  if (spread === null) return null;
  return widthWithOffset(spread, resolveOffset(data?.offsetToken0Pct));
}

/*- Mirror of the production `syncRangeWidth`.  Takes injected
 *  dependencies instead of importing DOM/posStore/isInputDirty so we
 *  can drive the function deterministically in a Node test.  Also
 *  keeps `_lastKnownPosKey` in a closure so each test gets a fresh
 *  gate state. */
function makeSyncRangeWidth() {
  let _lastKnownPosKey = null;
  return function syncRangeWidth(el, ctx) {
    const { data, posKey, isDirty } = ctx;
    if (!el) return;
    if (isDirty) return;
    if (!posKey) return;
    const isNewPosition = _lastKnownPosKey !== posKey;
    const saved = data.rebalanceRangeWidthPct;
    const hasSaved =
      saved !== undefined && saved !== null && Number.isFinite(saved);
    if (hasSaved) {
      if (isNewPosition || el.value === "") el.value = String(saved);
      _lastKnownPosKey = posKey;
      return;
    }
    if (isNewPosition) el.value = "";
    else if (el.value !== "") return;
    const widthPct = computeFallbackWidthPct(data);
    if (widthPct === null) return;
    el.value = widthPct;
    _lastKnownPosKey = posKey;
  };
}

/*- Mirror of `populateRangeWidthFromActive` — the synchronous
 *  click-time populate called from the Manage-click paths so the
 *  input is filled the instant the user commits to bringing a
 *  position under management (no wait on the 3-second poll).
 *  Reads the Position Offset from `ctx.offset` (production reads it
 *  from the `#inOffsetToken0` input value; falls back to centered
 *  50 if missing/invalid). */
function makePopulateFromActive() {
  return function populate(el, ctx) {
    const { active, isDirty, offset } = ctx;
    if (!el) return;
    if (isDirty) return;
    if (el.value !== "") return;
    if (!active) return;
    /*- Reuse the shared spread + width helpers so the mirror keeps
     *  the same guard set as `computeFallbackWidthPct` without
     *  duplicating the presence/finite/positive branches. */
    const spread = resolveSpread({ activePosition: active });
    if (spread === null) return;
    const widthPct = widthWithOffset(spread, resolveOffset(offset));
    if (widthPct === null) return;
    el.value = widthPct;
  };
}

// ── End-to-end flow tests ─────────────────────────────────────────────

describe("syncRangeWidth — flow (a) bring position under management", () => {
  it("populates from ticks on the first poll after Manage (poolState no longer required)", () => {
    /*- After Manage, the first poll delivers `data.activePosition`
     *  with the tick range.  The offset-aware `preserveRange`
     *  formula is a pure function of (spread, offset) — no
     *  `poolState.price` dependency — so the input populates on
     *  poll 1 without waiting for the bot cycle to complete
     *  getPoolState.  Regression guard against re-introducing a
     *  currentPrice dependency (which would delay populate by one
     *  bot-poll interval). */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    const posKey = "42";

    // Poll 1 after Manage: activePosition present with ticks
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
      },
      posKey,
      isDirty: false,
    });
    assert.match(
      el.value,
      /^\d+\.\d{2}$/,
      "poll 1 populates from ticks alone (no poolState needed)",
    );

    // Poll 2: input has value now → skip (same position, non-empty)
    const populatedValue = el.value;
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
      },
      posKey,
      isDirty: false,
    });
    assert.equal(
      el.value,
      populatedValue,
      "same position + input has value → skip (no drift as price moves)",
    );
  });

  it("writes saved override immediately on Manage if one exists", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(el, {
      data: { rebalanceRangeWidthPct: 12.5 },
      posKey: "42",
      isDirty: false,
    });
    assert.equal(el.value, "12.5");
  });
});

describe("syncRangeWidth — flow (b) unmanage → browse → back → Manage", () => {
  it("force-repopulates on position switch (clears stale value from prior position)", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("");

    // Position A: populate from fallback
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "A",
      isDirty: false,
    });
    const valueForA = el.value;
    assert.notEqual(valueForA, "");

    // Browse to position B (no saved, different ticks)
    sync(el, {
      data: {
        activePosition: { tickLower: -1000, tickUpper: 1000 },
        poolState: { price: 1 },
      },
      posKey: "B",
      isDirty: false,
    });
    assert.notEqual(
      el.value,
      valueForA,
      "posKey change forces repopulate with B's data",
    );
    const valueForB = el.value;

    // Browse back to A
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "A",
      isDirty: false,
    });
    assert.notEqual(
      el.value,
      valueForB,
      "browse back to A → forced repopulate with A's data (not B's stale)",
    );
    assert.equal(el.value, valueForA, "same A data → same computed value");
  });

  it("clears input on switch if new position has no fallback data yet", () => {
    /*- Prevents a stale value from the prior position from lingering
     *  while we wait for the new position's poolState.  Fixes the
     *  browse-away-then-back-to-fresh-Manage bug where B's input
     *  briefly showed A's value. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");

    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "A",
      isDirty: false,
    });
    assert.notEqual(el.value, "");

    // Switch to B with no fallback data (unmanaged, no poolState)
    sync(el, {
      data: { activePosition: {} },
      posKey: "B",
      isDirty: false,
    });
    assert.equal(el.value, "", "stale value cleared on switch to B");
  });
});

describe("syncRangeWidth — flow (c),(d) closed-position reopen (tokenId migration)", () => {
  it("re-populates for the newly-minted tokenId after rebalance-follow", () => {
    /*- On reopen, the rebalance mints a new NFT.  syncActivePosition
     *  migrates posStore's tokenId.  posKey change → syncRangeWidth
     *  force-repopulates for the new tokenId (same pool, same saved
     *  config value if any, or same preserveRange equivalent). */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    const savedForPool = 15;

    // Original closed tokenId
    sync(el, {
      data: { rebalanceRangeWidthPct: savedForPool },
      posKey: "closed-old-tokenId",
      isDirty: false,
    });
    assert.equal(el.value, "15");

    // After rebalance: new tokenId, same pool, same saved value
    sync(el, {
      data: { rebalanceRangeWidthPct: savedForPool },
      posKey: "new-minted-tokenId",
      isDirty: false,
    });
    assert.equal(
      el.value,
      "15",
      "new tokenId with same saved value writes idempotently",
    );
  });
});

describe("syncRangeWidth — flow (e) no LP positions on wallet", () => {
  it("returns early when posStore has no active position", () => {
    const sync = makeSyncRangeWidth();
    const el = makeInput("prior-value");
    sync(el, { data: {}, posKey: undefined, isDirty: false });
    assert.equal(el.value, "prior-value", "no posKey → no write");
  });
});

describe("syncRangeWidth — flow (f) app starts on closed position", () => {
  it("writes saved value if present, else leaves empty until Manage", () => {
    /*- Closed position, previously managed, saved override in config.
     *  No poolState (bot loop retired).  syncRangeWidth writes the
     *  saved value on first poll after posStore restore. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(el, {
      data: { rebalanceRangeWidthPct: 8 },
      posKey: "closed",
      isDirty: false,
    });
    assert.equal(el.value, "8");
  });

  it("populates from tick spread on startup for closed position with no saved value (poolState-independent)", () => {
    /*- Since the simplified formula only needs tickLower + tickUpper
     *  (no currentPrice), a closed position with tick data can
     *  populate immediately on app startup — no need to wait for
     *  Manage or poolState.  Ticks are in posStore from the scan
     *  and in `data.activePosition` from the server payload. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");
    sync(el, {
      data: { activePosition: { tickLower: -500, tickUpper: 500 } },
      posKey: "closed",
      isDirty: false,
    });
    assert.match(
      el.value,
      /^\d+\.\d{2}$/,
      "ticks present → populate from tick-spread formula (no poolState needed)",
    );
  });
});

// ── populateRangeWidthFromActive: synchronous click-time populate ─────

describe("populateRangeWidthFromActive — Manage click sync-populate", () => {
  it("populates from active position's ticks when input is empty", () => {
    /*- The Manage-click path calls this synchronously before POSTing
     *  to /api/position/manage so the field is filled the instant
     *  the user commits — no wait on the next 3-second poll. */
    const populate = makePopulateFromActive();
    const el = makeInput("");
    populate(el, {
      active: { tickLower: -500, tickUpper: 500, tokenId: "42" },
      isDirty: false,
    });
    assert.match(el.value, /^\d+\.\d{2}$/);
  });

  it("respects an existing non-empty value (prior populate or saved override)", () => {
    /*- If the input already has a value (from a prior populate, saved
     *  override, or user typing), don't overwrite.  The user's
     *  existing intent is authoritative. */
    const populate = makePopulateFromActive();
    const el = makeInput("15");
    populate(el, {
      active: { tickLower: -500, tickUpper: 500, tokenId: "42" },
      isDirty: false,
    });
    assert.equal(el.value, "15", "existing value preserved");
  });

  it("respects the dirty gate (user is typing)", () => {
    const populate = makePopulateFromActive();
    const el = makeInput("");
    populate(el, {
      active: { tickLower: -500, tickUpper: 500, tokenId: "42" },
      isDirty: true,
    });
    assert.equal(el.value, "", "dirty → skip");
  });

  it("no-op when no active position (flow e — empty wallet)", () => {
    const populate = makePopulateFromActive();
    const el = makeInput("");
    populate(el, { active: null, isDirty: false });
    assert.equal(el.value, "");
  });

  it("no-op when active has missing ticks", () => {
    const populate = makePopulateFromActive();
    const el = makeInput("");
    populate(el, {
      active: { tokenId: "42" },
      isDirty: false,
    });
    assert.equal(el.value, "");
  });

  it("no-op when active has non-finite ticks", () => {
    const populate = makePopulateFromActive();
    const el = makeInput("");
    populate(el, {
      active: { tickLower: NaN, tickUpper: 500, tokenId: "42" },
      isDirty: false,
    });
    assert.equal(el.value, "");
  });

  it("computes different widths for centered vs non-centered offset", () => {
    /*- Regression guard against the earlier centered-only formula.
     *  With the same tick spread but different Position Offset
     *  values, the computed width should differ (aboveTicks and
     *  belowTicks have different exponents in the asymmetric case). */
    const populate = makePopulateFromActive();
    const active = { tickLower: -500, tickUpper: 500, tokenId: "42" };
    const el1 = makeInput("");
    populate(el1, { active, isDirty: false, offset: 50 });
    const el2 = makeInput("");
    populate(el2, { active, isDirty: false, offset: 30 });
    assert.notEqual(
      el1.value,
      el2.value,
      "offset 50 vs 30 must produce different widths for the same spread",
    );
  });

  it("defaults to centered (offset=50) when offset is missing or invalid", () => {
    const populate = makePopulateFromActive();
    const active = { tickLower: -500, tickUpper: 500, tokenId: "42" };
    const el1 = makeInput("");
    populate(el1, { active, isDirty: false }); // offset undefined
    const el2 = makeInput("");
    populate(el2, { active, isDirty: false, offset: 50 });
    assert.equal(el1.value, el2.value);
    const el3 = makeInput("");
    populate(el3, { active, isDirty: false, offset: NaN });
    assert.equal(el1.value, el3.value);
    const el4 = makeInput("");
    populate(el4, { active, isDirty: false, offset: 101 });
    assert.equal(el1.value, el4.value);
  });
});

// ── Mid-typing protection ─────────────────────────────────────────────

describe("syncRangeWidth — mid-typing protection", () => {
  it("respects dirty gate (user is typing over saved value)", () => {
    /*- User has a saved value and is editing it.  The input event
     *  listener in dashboard-events.js marks dirty on every keystroke;
     *  dirty is cleared at end of poll.  syncRangeWidth must skip
     *  entirely when dirty. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("152"); // user typed "15" then added "2"
    sync(el, {
      data: { rebalanceRangeWidthPct: 15 },
      posKey: "42",
      isDirty: true,
    });
    assert.equal(el.value, "152", "dirty → skip (typing preserved)");
  });

  it("respects non-empty input on same position (no saved override)", () => {
    /*- User typed a value but hasn't Saved.  No saved override in
     *  config.  syncRangeWidth on same posKey must skip so the value
     *  isn't clobbered by a re-computed preserveRange. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");

    // First poll populates from fallback
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "42",
      isDirty: false,
    });
    const initialValue = el.value;
    assert.notEqual(initialValue, "");

    // User types something (dirty flag would be set by the input listener
    // in production; simulate by NOT setting dirty here to verify the
    // non-empty-input skip works even without the dirty gate).
    el.value = "20";

    // Next poll: same posKey, input non-empty, no saved → skip
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "42",
      isDirty: false,
    });
    assert.equal(
      el.value,
      "20",
      "same position + non-empty input → skip (respect populate/typing)",
    );
  });

  it("writes saved value to empty input after reset (No Override)", () => {
    /*- User clicks No Override → input cleared, POST null → server
     *  clears the config key.  Next poll: saved undefined, input
     *  empty → compute fallback + populate.  Verify the empty-input
     *  path re-triggers the fallback populate. */
    const sync = makeSyncRangeWidth();
    const el = makeInput("");

    // First populate
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "42",
      isDirty: false,
    });
    assert.notEqual(el.value, "");

    // Reset clears the input
    el.value = "";

    // Next poll: no saved, input empty, same posKey → repopulate from fallback
    sync(el, {
      data: {
        activePosition: { tickLower: -500, tickUpper: 500 },
        poolState: { price: 1 },
      },
      posKey: "42",
      isDirty: false,
    });
    assert.notEqual(
      el.value,
      "",
      "empty input on same position → retry fallback (No Override re-populate)",
    );
  });
});
