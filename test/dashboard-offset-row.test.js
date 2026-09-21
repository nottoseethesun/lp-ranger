"use strict";

/**
 * @file test/dashboard-offset-row.test.js
 * @description Tests for the Position Offset row's two buttons in
 * `public/dashboard-throttle.js` — `resetOffset` ("No Offset") and
 * `saveOffset` ("Save").
 *
 * The behaviour under test: **only Save persists.**  `resetOffset` used
 * to call `saveOffset()` internally, so clicking "No Offset" wrote to
 * `bot-config.json` immediately.  That was out of step with every other
 * edit row in the app — notably the sibling "Default" button on the
 * Price Range Extension row, which injects a value and waits for Save.
 * A button that silently persists is the kind of thing a user only
 * discovers after it has already changed how their position rebalances.
 *
 * Uses jsdom (via `global-jsdom/register`) so the real browser ES module
 * is driven end-to-end.  No mirrored copy of the SUT.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let data;

/*- Every POST the module fires, captured so a test can assert that a
 *  button wrote nothing at all. */
let posted;

before(async () => {
  mod = await import("../public/dashboard-throttle.js");
  data = await import("../public/dashboard-data.js");
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
    <input type="number" id="inOffsetToken0" value="70">
    <input type="number" id="inOffsetToken1" value="30">
    <div id="actList"></div>
  `;
  /*- Stand in for the `/api/bot-config-defaults` fetch that
   *  dashboard-init.js performs at page load. */
  data.setConfigInputDefault("offsetToken0Pct", 50);
});

const t0 = () => document.getElementById("inOffsetToken0").value;
const t1 = () => document.getElementById("inOffsetToken1").value;

describe("resetOffset — the No Offset button", () => {
  it("fills both inputs with the centered split", () => {
    mod.resetOffset();
    assert.equal(t0(), "50");
    assert.equal(t1(), "50");
  });

  it("persists NOTHING — only Save writes config", () => {
    /*- The regression this file exists for.  Clicking No Offset must
     *  leave the saved config untouched until the user commits with
     *  Save, matching the Price Range Extension row's Default button. */
    mod.resetOffset();
    assert.deepEqual(posted, []);
  });

  it("marks the input dirty so the next poll cannot clobber it", () => {
    /*- Same guard the Default button relies on: the injected value has
     *  to survive until the user decides whether to Save it. */
    const cache = require("../public/dashboard-data-cache.js");
    mod.resetOffset();
    assert.equal(cache.isInputDirty("inOffsetToken0"), true);
  });

  it("sources the centered value from the shipped defaults", () => {
    /*- No literal in the handler (feedback_one_literal_per_shipped_default).
     *  Drive that by handing it a different default and watching the
     *  injected values follow. */
    data.setConfigInputDefault("offsetToken0Pct", 40);
    mod.resetOffset();
    assert.equal(t0(), "40");
    assert.equal(t1(), "60");
    data.setConfigInputDefault("offsetToken0Pct", 50);
  });

  it("leaves the inputs untouched when no element is present", () => {
    document.body.innerHTML = `<div id="actList"></div>`;
    assert.doesNotThrow(() => mod.resetOffset());
    assert.deepEqual(posted, []);
  });
});

describe("saveOffset — the Save button", () => {
  it("is the only path that writes the offset to config", () => {
    mod.saveOffset();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, "/api/config");
    assert.equal(posted[0].body.offsetToken0Pct, 70);
  });

  it("persists what No Offset injected once the user commits it", () => {
    /*- The two-step the change introduces: inject, then Save. */
    mod.resetOffset();
    assert.deepEqual(posted, []);
    mod.saveOffset();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.offsetToken0Pct, 50);
  });

  it("keeps the complement input in sync when saving", () => {
    document.getElementById("inOffsetToken0").value = "35";
    mod.saveOffset();
    assert.equal(t1(), "65");
  });

  it("sends an out-of-range value rather than correcting it", () => {
    /*- The browser used to rewrite 140 to 100 and save that, so the
     *  operator got a setting they never chose and no sign of it.
     *  `src/config-bounds.js` refuses it by name instead, and
     *  `dashboard-config-save.js` puts the field back. */
    document.getElementById("inOffsetToken0").value = "140";
    mod.saveOffset();
    assert.equal(posted[0].body.offsetToken0Pct, 140);
  });

  it("saves an empty field as a clear, rather than going quiet", () => {
    /*- An empty field used to make Save do nothing at all — no save, no
     *  message, a button that looked broken. It now sends `null`, which
     *  is how the server is told to drop the override and fall back to
     *  the shipped default. */
    document.getElementById("inOffsetToken0").value = "";
    mod.saveOffset();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.offsetToken0Pct, null);
  });
});
