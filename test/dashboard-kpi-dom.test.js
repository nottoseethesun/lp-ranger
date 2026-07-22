"use strict";

/**
 * @file test/dashboard-kpi-dom.test.js
 * @description Tests for `setLeadingText` in `public/dashboard-kpi-dom.js`.
 *   Pins the DOM-write contract that live KPIs (dashboard-data-kpi) and
 *   closed-position historical KPIs (dashboard-closed-pos) share.  A
 *   stray text-node insertion here would leave a duplicate value beside
 *   the info "i" button on every KPI update — visible drift the user
 *   would report only after significant confusion.
 *
 *   Uses jsdom + direct import of the real browser module — no
 *   hand-rolled DOM stubs.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let setLeadingText;

before(async () => {
  ({ setLeadingText } = await import("../public/dashboard-kpi-dom.js"));
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("setLeadingText()", () => {
  it("no-op on null / undefined element (defensive)", () => {
    assert.doesNotThrow(() => setLeadingText(null, "any"));
    assert.doesNotThrow(() => setLeadingText(undefined, "any"));
  });

  it(
    "when firstChild IS a `.9mm-pos-mgr-kpi-val-wrap` span, writes into " +
      "the wrap's own leading text node — preserves the info-button sibling",
    () => {
      document.body.innerHTML = `
        <span id="outer"><span class="9mm-pos-mgr-kpi-val-wrap">OLD<button>i</button></span></span>
      `;
      const outer = document.getElementById("outer");
      const wrap = outer.firstElementChild;
      // Confirm setup: wrap's firstChild is the "OLD" text node.
      assert.strictEqual(wrap.firstChild.nodeType, 3);

      setLeadingText(outer, "NEW");

      assert.strictEqual(wrap.firstChild.textContent, "NEW");
      // Outer's structure untouched — no new child inserted.
      assert.strictEqual(outer.firstElementChild, wrap);
      // The button sibling inside the wrap is still there.
      assert.ok(wrap.querySelector("button"));
    },
  );

  it(
    "when firstChild is a plain text node, overwrites its textContent " +
      "in place (no new node created)",
    () => {
      document.body.innerHTML = `<span id="el">OLD</span>`;
      const el = document.getElementById("el");
      const before = el.firstChild;

      setLeadingText(el, "NEW");

      assert.strictEqual(el.firstChild.textContent, "NEW");
      assert.strictEqual(el.firstChild, before, "must reuse the text node");
      assert.strictEqual(el.childNodes.length, 1);
    },
  );

  it(
    "when firstChild is NOT a text node, inserts a new text node before it — " +
      "the info button remains intact as the (now) second child",
    () => {
      // firstChild is an <img>, an element (nodeType 1), not a text node.
      document.body.innerHTML = `<span id="el"><img alt="icon"><button>i</button></span>`;
      const el = document.getElementById("el");
      const img = el.querySelector("img");

      setLeadingText(el, "VALUE");

      assert.strictEqual(el.firstChild.nodeType, 3);
      assert.strictEqual(el.firstChild.textContent, "VALUE");
      // img still lives in the element, just no longer first.
      assert.strictEqual(el.childNodes[1], img);
    },
  );

  it("empty string is a valid update (clears the leading value)", () => {
    document.body.innerHTML = `<span id="el">OLD</span>`;
    const el = document.getElementById("el");
    setLeadingText(el, "");
    assert.strictEqual(el.firstChild.textContent, "");
  });
});
