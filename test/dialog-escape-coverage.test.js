/**
 * @file test/dialog-escape-coverage.test.js
 * @description Every dialog closes on Escape — except the one that must
 *   not.
 *
 * The Escape handler in `dashboard-events-manage.js` works off an
 * explicit id list, so a newly added dialog is opted OUT by default and
 * nothing complains. That is not hypothetical: `telegramModal` shipped
 * unregistered, and an audit found four more (`hodlBaselineModal`,
 * `noPositionsModal`, `priceOverrideModal`,
 * `slippageOutOfRangeModal`) still missing after that.
 *
 * So the list is checked against the markup rather than against itself:
 * every `modal-overlay` in `public/index.html` must be registered, and a
 * new dialog fails CI until it is.
 *
 * `walletUnlockModal` is the deliberate exception and is asserted to
 * stay out. Escape there would drop the operator to view-only on a
 * stray keypress; leaving the unlock prompt is a decision made with the
 * dialog's own button.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/** Overlay ids declared in the shipped markup. */
function markupOverlayIds() {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const ids = new Set();
  for (const tag of html.match(
    /<div[^>]*class="[^"]*modal-overlay[^"]*"[^>]*>/g,
  ) || []) {
    const m = tag.match(/id="([^"]+)"/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Ids the Escape handler's table names. */
function registeredIds() {
  const src = fs.readFileSync(
    path.join(ROOT, "public", "dashboard-events-manage.js"),
    "utf8",
  );
  return new Set([...src.matchAll(/id:\s*"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
}

/** Dialogs that must NOT be dismissible with Escape, and why. */
const DELIBERATE_OMISSIONS = {
  walletUnlockModal:
    "Escape must not drop the operator to view-only; that is a button decision",
};

describe("Escape closes every dialog", () => {
  it("registers every overlay in the markup", () => {
    const missing = [...markupOverlayIds()].filter(
      (id) => !registeredIds().has(id) && !(id in DELIBERATE_OMISSIONS),
    );
    assert.deepEqual(
      missing,
      [],
      `these dialogs would not close on Escape: ${missing.join(", ")}`,
    );
  });

  it("keeps the wallet unlock prompt out of the list", () => {
    for (const [id, why] of Object.entries(DELIBERATE_OMISSIONS)) {
      assert.ok(
        !registeredIds().has(id),
        `${id} must stay unregistered — ${why}`,
      );
    }
  });

  it("names a closer for the dialogs whose dismissal has side effects", () => {
    /*- These three dismiss by clicking their own button rather than by
     *  hiding the overlay: hodlBaselineModal writes the acknowledgement
     *  keys that stop it reappearing, and slippageOutOfRangeModal's OK
     *  IS the acknowledgement. Hiding the element directly would look
     *  identical on screen and silently skip that. */
    const src = fs.readFileSync(
      path.join(ROOT, "public", "dashboard-events-manage.js"),
      "utf8",
    );
    for (const btn of [
      "hodlBaselineClose",
      "noPositionsClose",
      "slipOorOkBtn",
      "slipAbove5CancelBtn",
      "slipAbove10CancelBtn",
    ]) {
      assert.match(src, new RegExp(`g\\("${btn}"\\)`), `${btn} not routed`);
    }
  });
});
