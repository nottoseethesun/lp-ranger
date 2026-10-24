"use strict";

/**
 * @file test/dashboard-range-override.test.js
 * @description Tests for `src/client/web/dashboard-range-override.js` — the
 * "No Override" toggle heading Bot Settings → Range, its status badge,
 * and the enable/disable state of every field it governs.
 *
 * Uses jsdom (via `global-jsdom/register`) so the real browser ES module
 * is imported and driven end-to-end against a real DOM.  No mirrored
 * copy of the SUT.
 *
 * What these lock in:
 *
 *   - The badge and the fields always agree with each other, because a
 *     badge reading "Re-Use Existing Position Range" over an editable
 *     Price Range Extension field would be an outright lie about what
 *     the next rebalance does.
 *   - `applyRangeFieldState` is the SOLE writer of `disabled` across the
 *     section.  Two independent reasons can disable the width input (the
 *     toggle, and the Full-Range checkbox); when ownership was split
 *     across modules, whichever ran last won.
 *   - The toggle writes ONLY `rangeOverrideEnabled`.  It must never
 *     clear the values it suppresses — that non-destructiveness is the
 *     whole difference from the button it replaced.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");

let mod;
let helpers;

/*- Every POST the module fires, captured so the tests can assert on the
 *  request body without a network stub reaching outside the process. */
let posted;

before(async () => {
  // As at startup: the dashboard knows its chain before it keys a position.
  await learnActiveChain();
  mod = await import("../src/client/web/dashboard-range-override.js");
  helpers = await import("../src/client/web/dashboard-helpers.js");
  const store = await import("../src/client/web/dashboard-positions-store.js");
  /*- Give the module an active position so it builds a composite key the
   *  way the running dashboard does.  posStore is a module-graph
   *  singleton; seed `entries` / `activeIdx` directly rather than going
   *  through `select()`, which also persists to localStorage. */
  store.posStore.entries.length = 0;
  store.posStore.entries.push({
    tokenId: "157149",
    walletAddress: "0x4e44A5D8B0Ba1d6c93B0b0B4E2e3D4a5B6c7D8e9",
    contractAddress: "0xCC05bF158Ce292c3E3D5cF7Ee0dDa0FE8dBa9F6b",
    tickLower: -100,
    tickUpper: 100,
  });
  store.posStore.activeIdx = 0;
});

beforeEach(() => {
  posted = [];
  global.fetch = (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  document.body.innerHTML = `
    <span id="rangeModeBadge" hidden></span>
    <input type="checkbox" id="rangeOverrideToggle">
    <input type="number" id="inRangeWidth">
    <input type="checkbox" id="chkFullRange">
    <button id="defaultRangeWidthBtn"></button>
    <button id="saveRangeWidthBtn"></button>
    <input type="number" id="inOffsetToken0">
    <input type="number" id="inOffsetToken1">
    <button id="resetOffsetBtn"></button>
    <button id="saveOffsetBtn"></button>
    <div id="actList"></div>
  `;
});

/*- Read the ids the module gates.  Kept local and explicit so a test
 *  failure names the control that regressed. */
const GATED = [
  "inRangeWidth",
  "chkFullRange",
  "defaultRangeWidthBtn",
  "saveRangeWidthBtn",
  "inOffsetToken0",
  "inOffsetToken1",
  "resetOffsetBtn",
  "saveOffsetBtn",
];

function disabledIds() {
  return GATED.filter((id) => document.getElementById(id).disabled);
}

describe("computeRangeOverrideUi", () => {
  it("maps an override-active payload to the 'Use Settings Below' badge", () => {
    const d = mod.computeRangeOverrideUi({ rangeOverrideEnabled: true });
    assert.equal(d.overrideActive, true);
    assert.equal(d.badgeText, "Use Settings Below");
    assert.equal(d.toggleChecked, false);
  });

  it("maps an override-off payload to the 'Re-Use' badge", () => {
    const d = mod.computeRangeOverrideUi({ rangeOverrideEnabled: false });
    assert.equal(d.overrideActive, false);
    assert.equal(d.badgeText, "Re-Use Existing Position Range");
    assert.equal(d.toggleChecked, true);
  });

  it("reads the toggle inverted against the config key it writes", () => {
    /*- The checkbox says "No Override", the key says "override
     *  enabled".  Getting this backwards would silently invert every
     *  position's range behaviour, so pin it explicitly. */
    assert.equal(
      mod.computeRangeOverrideUi({ rangeOverrideEnabled: true }).toggleChecked,
      false,
    );
    assert.equal(
      mod.computeRangeOverrideUi({ rangeOverrideEnabled: false }).toggleChecked,
      true,
    );
  });

  it("falls back to 'No Override' for a payload with no answer", () => {
    /*- Wallet locked, first paint before any poll, or a position the
     *  server has no slot for.  The safe reading is the one that does
     *  not reshape the user's range. */
    for (const payload of [{}, null, undefined, { rangeOverrideEnabled: null }])
      assert.equal(mod.computeRangeOverrideUi(payload).overrideActive, false);
  });
});

describe("applyRangeFieldState", () => {
  it("disables every governed control when the toggle is on", () => {
    mod.applyRangeFieldState(false, false);
    assert.deepEqual(disabledIds(), GATED);
  });

  it("enables every governed control when the toggle is off", () => {
    mod.applyRangeFieldState(true, false);
    assert.deepEqual(disabledIds(), []);
  });

  it("keeps the width input disabled for Full-Range even with the toggle off", () => {
    /*- Two independent reasons to disable the same input.  The
     *  rebalancer ignores the Price Range Extension when Full-Range is
     *  on, so the field must stay greyed out. */
    mod.applyRangeFieldState(true, true);
    assert.deepEqual(disabledIds(), ["inRangeWidth"]);
  });

  it("re-enables the width input when Full-Range is unchecked", () => {
    mod.applyRangeFieldState(true, true);
    mod.applyRangeFieldState(true, false);
    assert.equal(document.getElementById("inRangeWidth").disabled, false);
  });

  it("the toggle beats Full-Range: everything off means everything off", () => {
    mod.applyRangeFieldState(false, true);
    assert.deepEqual(disabledIds(), GATED);
  });
});

describe("syncRangeOverride", () => {
  it("paints the badge, the toggle and the fields from one payload", () => {
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    assert.equal(
      document.getElementById("rangeModeBadge").textContent,
      "Use Settings Below",
    );
    assert.equal(document.getElementById("rangeOverrideToggle").checked, false);
    assert.deepEqual(disabledIds(), []);
  });

  it("badge and field state never disagree", () => {
    /*- The failure this guards against is a badge saying the existing
     *  range will be re-used while the fields sit editable, which reads
     *  as "these values apply". */
    mod.syncRangeOverride({ rangeOverrideEnabled: false });
    assert.equal(
      document.getElementById("rangeModeBadge").textContent,
      "Re-Use Existing Position Range",
    );
    assert.deepEqual(disabledIds(), GATED);
  });

  it("carries the calm mode class only in the re-use state", () => {
    const badge = document.getElementById("rangeModeBadge");
    mod.syncRangeOverride({ rangeOverrideEnabled: false });
    assert.ok(badge.classList.contains("9mm-pos-mgr-range-mode-reuse"));
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    assert.ok(!badge.classList.contains("9mm-pos-mgr-range-mode-reuse"));
  });

  it("reveals the badge, which ships hidden to avoid a first-paint flash", () => {
    const badge = document.getElementById("rangeModeBadge");
    assert.equal(badge.hidden, true, "starts hidden as authored in the HTML");
    mod.syncRangeOverride({ rangeOverrideEnabled: false });
    assert.equal(badge.hidden, false);
  });

  it("honours a checked Full-Range box while the toggle is off", () => {
    document.getElementById("chkFullRange").checked = true;
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    assert.deepEqual(disabledIds(), ["inRangeWidth"]);
  });

  it("exposes the rendered mode without anyone reading the DOM back", () => {
    /*- feedback_no_classlist_for_state: callers that need the mode ask
     *  the module, never an input's `disabled` property. */
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    assert.equal(mod.isRangeOverrideActive(), true);
    mod.syncRangeOverride({ rangeOverrideEnabled: false });
    assert.equal(mod.isRangeOverrideActive(), false);
  });
});

describe("saveRangeOverrideToggle", () => {
  it("posts rangeOverrideEnabled=false when the user turns No Override on", () => {
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    document.getElementById("rangeOverrideToggle").checked = true;
    mod.saveRangeOverrideToggle();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, "/api/config");
    assert.equal(posted[0].body.rangeOverrideEnabled, false);
  });

  it("posts rangeOverrideEnabled=true when the user turns No Override off", () => {
    mod.syncRangeOverride({ rangeOverrideEnabled: false });
    document.getElementById("rangeOverrideToggle").checked = false;
    mod.saveRangeOverrideToggle();
    assert.equal(posted[0].body.rangeOverrideEnabled, true);
  });

  it("writes ONLY the toggle key — it never clears what it suppresses", () => {
    /*- The non-destructiveness that makes this a toggle rather than the
     *  one-way button it replaced.  If a future edit reintroduces a
     *  clearing POST here, flipping back would silently lose the user's
     *  saved width and offset. */
    document.getElementById("rangeOverrideToggle").checked = true;
    mod.saveRangeOverrideToggle();
    const body = posted[0].body;
    assert.ok(!("rebalanceRangeWidthPct" in body));
    assert.ok(!("fullRangeRebalanceEnabled" in body));
    assert.ok(!("offsetToken0Pct" in body));
    assert.deepEqual(Object.keys(body).sort(), [
      "positionKey",
      "rangeOverrideEnabled",
    ]);
  });

  it("sends the active position's composite key", () => {
    document.getElementById("rangeOverrideToggle").checked = true;
    mod.saveRangeOverrideToggle();
    assert.equal(
      posted[0].body.positionKey,
      helpers.compositeKey(
        "pulsechain",
        "0x4e44A5D8B0Ba1d6c93B0b0B4E2e3D4a5B6c7D8e9",
        "0xCC05bF158Ce292c3E3D5cF7Ee0dDa0FE8dBa9F6b",
        "157149",
      ),
    );
  });

  it("repaints immediately instead of waiting for the next poll", () => {
    /*- The dashboard polls every 3 s.  A toggle that looked inert for
     *  that long would invite a second click. */
    mod.syncRangeOverride({ rangeOverrideEnabled: true });
    document.getElementById("rangeOverrideToggle").checked = true;
    mod.saveRangeOverrideToggle();
    assert.equal(
      document.getElementById("rangeModeBadge").textContent,
      "Re-Use Existing Position Range",
    );
    assert.deepEqual(disabledIds(), GATED);
    assert.equal(mod.isRangeOverrideActive(), false);
  });

  it("survives a POST rejection without leaving the UI half-painted", () => {
    global.fetch = () => Promise.reject(new Error("offline"));
    document.getElementById("rangeOverrideToggle").checked = true;
    assert.doesNotThrow(() => mod.saveRangeOverrideToggle());
    assert.equal(
      document.getElementById("rangeModeBadge").textContent,
      "Re-Use Existing Position Range",
    );
  });
});
