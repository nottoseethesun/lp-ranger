"use strict";

/**
 * @file test/dashboard-baseline-dialog.test.js
 * @description The IL Baseline dialog keeps working after its "price
 *   unavailable" message has shown.
 *
 *   The dialog has two messages: the entry value LP Ranger found for a
 *   pool, and the coins whose prices it could not find. Each has its own
 *   lines in the dialog (`_showBaselineModal`,
 *   public/dashboard-data-baseline.js), so showing one never removes the
 *   places the other writes into, and the dialog can show either next
 *   time, for any position. Driven on the dialog's own markup from
 *   public/index.html.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

let baseline;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await learnActiveChain();
  baseline = await import("../public/dashboard-data-baseline.js");
});

beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("hodlBaselineModal"), true),
  );
});

const shown = (id) =>
  !document.getElementById(id).classList.contains("9mm-pos-mgr-hidden");

/** The entry value a status answer carries for a pool just detected. */
const found = {
  hodlBaseline: { entryValue: 1234, mintDate: "2026-05-01" },
};

describe("the IL Baseline dialog", () => {
  it("shows the missing prices on their own line", () => {
    baseline._showBaselineModal({}, true, false, false, ["HEX"]);
    const msg = document.getElementById("hodlBaselinePriceMsg");
    assert.match(msg.textContent, /Price unavailable for HEX/);
    assert.ok(shown("hodlBaselinePriceMsg"));
    assert.ok(!shown("hodlBaselineFound"), "no entry value to show");
  });

  it("still shows an entry value found after the price message", () => {
    baseline._showBaselineModal({}, true, false, false, ["HEX"]);
    document.getElementById("hodlBaselineModal").className =
      "modal-overlay hidden";

    baseline._showBaselineModal(found, false, true, false, []);
    const modal = document.getElementById("hodlBaselineModal");
    assert.equal(modal.className, "modal-overlay", "the dialog opens");
    assert.match(
      document.getElementById("hodlBaselineAmt").textContent,
      /1,234/,
    );
    assert.equal(
      document.getElementById("hodlBaselineDate").textContent,
      "2026-05-01",
    );
    assert.ok(shown("hodlBaselineFound"));
    assert.ok(shown("hodlBaselineFoundNote"));
    assert.ok(!shown("hodlBaselinePriceMsg"), "the old message is gone");
  });
});
