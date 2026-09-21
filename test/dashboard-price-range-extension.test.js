"use strict";

/**
 * @file test/dashboard-price-range-extension.test.js
 * @description Tests for the Price Range Extension row in
 * `public/dashboard-price-range-extension.js`: the Default button, the
 * Full-Range checkbox, and the Save button that commits both.
 *
 * The row's contract, which these pin:
 *
 *   1. **Only Save persists.**  Neither Default nor the Full-Range
 *      checkbox writes config.  These settings reshape the position on
 *      the next rebalance, so nothing applies that the user has not
 *      committed.
 *   2. **Save commits the whole row in one request** — the extension and
 *      the Full-Range boolean together — so the two can never land out
 *      of step with each other.
 *   3. **Default unticks Full-Range.**  The rebalancer ignores the
 *      extension entirely while full-range is on, so a default injected
 *      under a ticked box would sit in a disabled field and never take
 *      effect.
 *
 * Uses jsdom (via `global-jsdom/register`) so the real browser ES module
 * is driven end-to-end.  No mirrored copy of the SUT.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let data;
let cache;
let rangeOverride;

/*- Every POST the module fires, so a test can assert a button wrote
 *  nothing at all. */
let posted;

before(async () => {
  mod = await import("../public/dashboard-price-range-extension.js");
  data = await import("../public/dashboard-data.js");
  cache = await import("../public/dashboard-data-cache.js");
  rangeOverride = await import("../public/dashboard-range-override.js");
  const store = await import("../public/dashboard-positions-store.js");
  store.posStore.entries.length = 0;
  store.posStore.entries.push({
    tokenId: "157149",
    walletAddress: "0x4e44A5D8B0Ba1d6c93B0b0B4E2e3D4a5B6c7D8e9",
    contractAddress: "0xCC05bF158Ce292c3E3D5cF7Ee0dDa0FE8dBa9F6b",
  });
  store.posStore.activeIdx = 0;
});

beforeEach(() => {
  posted = [];
  global.fetch = (url, init) => {
    posted.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  document.body.innerHTML = `
    <input type="number" id="inRangeWidth">
    <input type="checkbox" id="chkFullRange">
    <button id="defaultRangeWidthBtn"></button>
    <button id="saveRangeWidthBtn"></button>
    <input type="number" id="inOffsetToken0">
    <input type="number" id="inOffsetToken1">
    <button id="resetOffsetBtn"></button>
    <button id="saveOffsetBtn"></button>
    <span id="rangeModeBadge" hidden></span>
    <input type="checkbox" id="rangeOverrideToggle">
    <div id="actList"></div>
  `;
  cache.clearDirtyInputs();
  /*- Stand in for the `/api/bot-config-defaults` fetch that
   *  dashboard-init.js performs at page load. */
  data.setConfigInputDefault("rebalanceRangeWidthPct", 80);
  /*- And for the first poll.  The row is only reachable in "Use
   *  Settings Below" mode — the "No Override" toggle disables every
   *  control on it — so that is the state these tests run in.
   *  `applyRangeFieldState` reads the mode from this module, so without
   *  it every field would start disabled and the assertions below would
   *  be measuring the wrong thing. */
  rangeOverride.syncRangeOverride({ rangeOverrideEnabled: true });
});

const width = () => document.getElementById("inRangeWidth");
const fullRange = () => document.getElementById("chkFullRange");

describe("setDefaultRangeWidth — the Default button", () => {
  it("injects the shipped default into the extension input", () => {
    mod.setDefaultRangeWidth();
    assert.equal(width().value, "80");
  });

  it("unticks Full-Range", () => {
    /*- The reported gap: the number went in but the box stayed ticked,
     *  leaving a value that the rebalancer would ignore. */
    fullRange().checked = true;
    mod.setDefaultRangeWidth();
    assert.equal(fullRange().checked, false);
  });

  it("re-enables the extension input it just filled", () => {
    /*- A ticked Full-Range box disables the input.  Unticking has to
     *  hand it back, or the user sees a default they cannot edit. */
    fullRange().checked = true;
    rangeOverride.applyRangeFieldState(true, true);
    assert.equal(width().disabled, true, "sanity: disabled while ticked");
    mod.setDefaultRangeWidth();
    assert.equal(width().disabled, false);
  });

  it("persists nothing — Save is still required", () => {
    fullRange().checked = true;
    mod.setDefaultRangeWidth();
    assert.deepEqual(posted, []);
  });

  it("marks both staged changes dirty so a poll cannot revert them", () => {
    fullRange().checked = true;
    mod.setDefaultRangeWidth();
    assert.equal(cache.isInputDirty("inRangeWidth"), true);
    assert.equal(cache.isInputDirty("chkFullRange"), true);
  });

  it("leaves an already-unticked box alone", () => {
    /*- Nothing changed, so nothing to protect from the sync. */
    mod.setDefaultRangeWidth();
    assert.equal(fullRange().checked, false);
    assert.equal(cache.isInputDirty("chkFullRange"), false);
  });
});

describe("computeRangeRowPatch — what Save commits", () => {
  it("always carries the Full-Range boolean", () => {
    assert.equal(
      mod.computeRangeRowPatch("25", true).fullRangeRebalanceEnabled,
      true,
    );
    assert.equal(
      mod.computeRangeRowPatch("25", false).fullRangeRebalanceEnabled,
      false,
    );
  });

  it("carries a legal extension alongside it", () => {
    assert.equal(
      mod.computeRangeRowPatch("25", false).rebalanceRangeWidthPct,
      25,
    );
  });

  it("omits the extension only when the row is not asking for one", () => {
    /*- An empty or unparseable field means "no width override", which
     *  is the one case the key is left out. */
    for (const raw of ["", "abc", undefined])
      assert.ok(
        !("rebalanceRangeWidthPct" in mod.computeRangeRowPatch(raw, false)),
        `"${raw}" should not be saved as an extension`,
      );
  });

  it("sends an out-of-range figure rather than dropping it", () => {
    /*- Dropping it here logged "Setting Saved" over a width nothing
     *  stored. It goes to the server, which refuses it by name
     *  (`src/config-bounds.js`) and has the field put back. */
    for (const raw of ["0", "0.05", "201"])
      assert.equal(
        mod.computeRangeRowPatch(raw, false).rebalanceRangeWidthPct,
        Number(raw),
        `"${raw}" should be sent for the server to judge`,
      );
  });

  it("accepts the documented bounds exactly", () => {
    assert.equal(
      mod.computeRangeRowPatch("0.1", false).rebalanceRangeWidthPct,
      0.1,
    );
    assert.equal(
      mod.computeRangeRowPatch("200", false).rebalanceRangeWidthPct,
      200,
    );
  });
});

describe("saveRangeWidth — the Save button", () => {
  it("commits the whole row in one request", () => {
    /*- One POST, so the extension and the Full-Range flag can never
     *  land out of step with each other on disk. */
    width().value = "25";
    fullRange().checked = false;
    mod.saveRangeWidth();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, "/api/config");
    assert.equal(posted[0].body.rebalanceRangeWidthPct, 25);
    assert.equal(posted[0].body.fullRangeRebalanceEnabled, false);
  });

  it("persists what Default staged", () => {
    fullRange().checked = true;
    mod.setDefaultRangeWidth();
    assert.deepEqual(posted, [], "sanity: Default wrote nothing");
    mod.saveRangeWidth();
    assert.equal(posted[0].body.rebalanceRangeWidthPct, 80);
    assert.equal(posted[0].body.fullRangeRebalanceEnabled, false);
  });

  it("saves Full-Range on its own when the extension is empty", () => {
    /*- With the box ticked the extension is ignored anyway, so an empty
     *  field must not block the checkbox from being committed. */
    width().value = "";
    fullRange().checked = true;
    mod.saveRangeWidth();
    assert.equal(posted[0].body.fullRangeRebalanceEnabled, true);
    assert.ok(!("rebalanceRangeWidthPct" in posted[0].body));
  });

  it("sends the active position's key", () => {
    width().value = "25";
    mod.saveRangeWidth();
    assert.match(posted[0].body.positionKey, /^pulsechain-0x.*-157149$/);
  });
});

describe("onFullRangeToggle — the Full-Range checkbox", () => {
  it("persists nothing", () => {
    /*- The checkbox must not POST on its own `change` event: that
     *  applies a range-reshaping setting on a stray click, with no
     *  Save to commit it. */
    fullRange().checked = true;
    mod.onFullRangeToggle();
    assert.deepEqual(posted, []);
  });

  it("disables the extension input when ticked", () => {
    rangeOverride.applyRangeFieldState(true, false);
    fullRange().checked = true;
    mod.onFullRangeToggle();
    assert.equal(width().disabled, true);
  });

  it("re-enables the extension input when unticked", () => {
    fullRange().checked = true;
    mod.onFullRangeToggle();
    fullRange().checked = false;
    mod.onFullRangeToggle();
    assert.equal(width().disabled, false);
  });

  it("marks itself dirty so the poll cannot revert an uncommitted tick", () => {
    fullRange().checked = true;
    mod.onFullRangeToggle();
    assert.equal(cache.isInputDirty("chkFullRange"), true);
  });
});
