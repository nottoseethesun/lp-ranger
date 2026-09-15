"use strict";

/**
 * @file test/dashboard-param-help-label.test.js
 * @description Regression test for the info-icon-inside-a-label bug.
 *
 * The bug: the circle-i beside "No Override" in Bot Settings → Range sat
 * inside the toggle's `<label>`, and a click anywhere in a label
 * activates the control it wraps.  So opening the help dialog ALSO
 * flipped the toggle — silently changing how the position rebalances,
 * on a click the user made in order to *read about* the setting.
 *
 * The fix is structural: the icon is now a sibling of the `<label>`,
 * which wraps only the checkbox and its track.  `preventDefault()` in
 * the delegated `[data-param-help]` handler was tried first and
 * rejected — it suppresses label activation in some engines and not
 * others (jsdom flips the box regardless), so it would have shipped a
 * guard that only appeared to work.
 *
 * These tests assert the structure, over the shipped `public/index.html`
 * itself, so a future edit that nests an info icon back inside a label
 * trips CI rather than reaching the browser.  The first test proves the
 * hazard is real in this DOM implementation; the rest prove no shipped
 * markup is exposed to it.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let doc;

before(() => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "index.html"),
    "utf8",
  );
  doc = new window.DOMParser().parseFromString(html, "text/html");
});

describe("info icons are never nested inside a form label", () => {
  it("a nested icon really does flip the control (the hazard is real)", () => {
    /*- Reproduces the original bug in a throwaway DOM so the rule below
     *  is anchored to observed behaviour, not folklore. */
    document.body.innerHTML = `
      <label>
        <input type="checkbox" id="hazardBox">
        <span id="hazardIcon" data-param-help="x">i</span>
      </label>
    `;
    document
      .getElementById("hazardIcon")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(
      document.getElementById("hazardBox").checked,
      true,
      "clicking an icon inside a label activates the label's control",
    );
  });

  it("no [data-param-help] in index.html sits inside a label", () => {
    const offenders = [...doc.querySelectorAll("[data-param-help]")]
      .filter((el) => el.closest("label"))
      .map((el) => el.dataset.paramHelp);
    assert.deepEqual(
      offenders,
      [],
      "move these icons out of their <label>: clicking them would " +
        "toggle the control the label wraps",
    );
  });

  it("the No Override icon is a sibling of the toggle, not a child", () => {
    /*- An info icon inside the `<label>` is clickable as part of it, so
     *  opening the help dialog also toggles the control it labels. */
    const icon = doc.querySelector('[data-param-help="rangeOverrideToggle"]');
    assert.ok(icon, "the No Override info icon exists");
    assert.equal(icon.closest("label"), null);
  });

  it("the No Override label still wraps the checkbox and its track", () => {
    /*- The icon moving out must not cost the toggle its own label: the
     *  track is a styled <span>, so without the wrapping label there is
     *  nothing to click. */
    const label = doc.querySelector(".\\39mm-pos-mgr-range-toggle");
    assert.ok(label, "the toggle label exists");
    assert.equal(label.tagName, "LABEL");
    assert.ok(label.querySelector("#rangeOverrideToggle"), "wraps the input");
    assert.ok(
      label.querySelector(".\\39mm-pos-mgr-toggle-track"),
      "wraps the track",
    );
  });
});
