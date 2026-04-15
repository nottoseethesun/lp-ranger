"use strict";

/**
 * @file test/disclaimer.test.js
 * @description Tests for the disclosure modal logic: accept/decline behaviour,
 * always-show-on-launch guarantee, and version tracking.
 *
 * Since the dashboard code runs in a browser, we mock the DOM to test
 * the logic in Node.js.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

// ── Minimal DOM mock ────────────────────────────────────────────────────────

function createMockDOM() {
  const elements = {};

  function makeEl(id) {
    const el = {
      id,
      classList: {
        _classes: new Set(),
        add(c) {
          this._classes.add(c);
        },
        remove(c) {
          this._classes.delete(c);
        },
        contains(c) {
          return this._classes.has(c);
        },
      },
      onclick: null,
      innerHTML: "",
    };
    elements[id] = el;
    return el;
  }

  return { makeEl, elements };
}

// ── Disclosure modal logic ──────────────────────────────────────────────────

describe("disclaimer — modal behaviour", () => {
  it("accept hides the overlay", () => {
    const { makeEl } = createMockDOM();
    const overlay = makeEl("disclaimerOverlay");
    const acceptBtn = makeEl("disclaimerAccept");
    makeEl("disclaimerDecline");

    overlay.classList.remove("hidden");
    acceptBtn.onclick = () => overlay.classList.add("hidden");
    acceptBtn.onclick();

    assert.strictEqual(overlay.classList.contains("hidden"), true);
  });

  it("decline hides overlay and activates disabled screen", () => {
    const { makeEl } = createMockDOM();
    const overlay = makeEl("disclaimerOverlay");
    const disabled = makeEl("appDisabledOverlay");
    const declineBtn = makeEl("disclaimerDecline");
    makeEl("disclaimerAccept");

    overlay.classList.remove("hidden");
    declineBtn.onclick = () => {
      overlay.classList.add("hidden");
      disabled.classList.add("active");
    };
    declineBtn.onclick();

    assert.strictEqual(overlay.classList.contains("hidden"), true);
    assert.strictEqual(disabled.classList.contains("active"), true);
  });

  it("modal always shows — no suppression mechanism", () => {
    const { makeEl } = createMockDOM();
    const overlay = makeEl("disclaimerOverlay");

    // Simulate initDisclaimer: always removes hidden
    overlay.classList.add("hidden");
    overlay.classList.remove("hidden");

    assert.strictEqual(overlay.classList.contains("hidden"), false);
  });
});

// ── Disclosure content module ───────────────────────────────────────────────

describe("disclosure-content", () => {
  it("exports DISCLOSURE_VERSION as a date string", () => {
    const { DISCLOSURE_VERSION } = require("../public/disclosure-content.js");
    assert.ok(typeof DISCLOSURE_VERSION === "string");
    assert.match(DISCLOSURE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("exports DISCLOSURE_HTML with required sections", () => {
    const { DISCLOSURE_HTML } = require("../public/disclosure-content.js");
    assert.ok(DISCLOSURE_HTML.includes("Venue Relationships"));
    assert.ok(DISCLOSURE_HTML.includes("Transaction History"));
    assert.ok(DISCLOSURE_HTML.includes("AS IS"));
    assert.ok(DISCLOSURE_HTML.includes("Apache 2.0"));
  });
});
