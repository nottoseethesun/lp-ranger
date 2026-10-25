/**
 * @file test/dialog-escape-coverage.test.js
 * @description Every dialog closes on Escape — except the one that must
 *   not.
 *
 * The Escape handler in `dashboard-events-manage.js` works off an
 * explicit id list: its own entries, and the dialogs that belong to the
 * position on screen, spread in from `POSITION_MODALS`
 * (`dashboard-position-dialogs.js`). A newly added dialog is therefore
 * opted OUT by default, and nothing on screen says so.
 *
 * So the list is checked against the markup rather than against itself:
 * every `modal-overlay` in `src/client/web/index.html` must be registered, and a
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
  const html = fs.readFileSync(
    path.join(ROOT, "src", "client", "web", "index.html"),
    "utf8",
  );
  const ids = new Set();
  for (const tag of html.match(
    /<div[^>]*class="[^"]*modal-overlay[^"]*"[^>]*>/g,
  ) || []) {
    const m = tag.match(/id="([^"]+)"/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** The source of one dashboard module. */
const source = (name) =>
  fs.readFileSync(path.join(ROOT, "src", "client", "web", name), "utf8");

/** The two sources the Escape handler's table is written in. */
function escapeTableSources() {
  return [
    source("dashboard-events-manage.js"),
    source("dashboard-position-dialogs.js"),
  ].join("\n");
}

/** Ids the Escape handler's table names. */
function registeredIds() {
  return new Set(
    [...escapeTableSources().matchAll(/id:\s*"([A-Za-z0-9]+)"/g)].map(
      (m) => m[1],
    ),
  );
}

/** Dialogs that must NOT be dismissible with Escape, and why. */
const DELIBERATE_OMISSIONS = {
  walletUnlockModal:
    "Escape must not drop the operator to view-only; that is a button decision",
};

describe("Escape closes every dialog", () => {
  it("takes in the dialogs that belong to the position on screen", () => {
    assert.match(
      source("dashboard-events-manage.js"),
      /^\s*\.\.\.POSITION_MODALS,$/m,
    );
  });

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
    /*- These dismiss by clicking their own button rather than by hiding
     *  the overlay: hodlBaselineModal writes the acknowledgement keys
     *  that stop it reappearing, and the two slippage confirmations
     *  leave a pending save dangling unless their Cancel runs. Hiding
     *  the element directly would look identical on screen and silently
     *  skip that. */
    const src = escapeTableSources();
    for (const btn of [
      "hodlBaselineClose",
      "noPositionsClose",
      "slipAbove5CancelBtn",
      "slipAbove10CancelBtn",
    ]) {
      assert.match(src, new RegExp(`g\\("${btn}"\\)`), `${btn} not routed`);
    }
  });
});
