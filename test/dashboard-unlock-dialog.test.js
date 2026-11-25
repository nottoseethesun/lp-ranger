"use strict";

/**
 * @file test/dashboard-unlock-dialog.test.js
 * @description The unlock dialog opens with no error left from an earlier
 *   try (`showUnlockDialog`, src/client/web/js/dashboard-wallet.js). A
 *   wrong password shown when the operator dismissed the dialog to view
 *   only would otherwise greet the next unlock. The Unlock Wallet button
 *   opens it through that function (src/client/web/js/dashboard-events.js),
 *   clicked here on the page with the dashboard's own handlers bound, and
 *   so does the check that finds the wallet locked as the page loads.
 *
 *   Runs on the dashboard's own markup (src/client/web/index.html), where
 *   the dialog and its error start hidden and the button disabled.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

let walletModule;
let eventsModule;

const dialog = () => document.getElementById("walletUnlockModal");
const error = () => document.getElementById("unlockError");

/** Show the dialog with an error from an earlier try in it. */
function showAnError() {
  dialog().classList.remove("hidden");
  error().textContent = "Wrong password";
  error().classList.remove("hidden");
}

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
  await learnUiSettings();
  walletModule = await import("../src/client/web/js/dashboard-wallet.js");
  eventsModule = await import("../src/client/web/js/dashboard-events.js");
});

beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
});

describe("the unlock dialog", () => {
  it("opens with the error from an earlier try hidden", () => {
    showAnError();
    walletModule.dismissToViewOnly();
    walletModule.showUnlockDialog();
    assert.ok(!dialog().classList.contains("hidden"), "dialog shown");
    assert.ok(error().classList.contains("hidden"), "old error hidden");
  });

  it("opens from the Unlock Wallet button after View-Only, with no old error", () => {
    eventsModule.bindAllEvents();
    showAnError();
    document.getElementById("viewOnlyBtn").click();
    assert.ok(dialog().classList.contains("hidden"), "dismissed");
    const unlock = document.getElementById("unlockWalletBtn");
    assert.equal(unlock.disabled, false, "View-Only enables the button");
    unlock.click();
    assert.ok(!dialog().classList.contains("hidden"), "dialog shown");
    assert.ok(error().classList.contains("hidden"), "old error hidden");
  });

  it("opens the same way when the wallet is found locked", async () => {
    showAnError();
    walletModule.dismissToViewOnly();
    /*-
     *  TEST-ONLY global swap: the check asks the server for the wallet's
     *  status through `fetch`, and takes no seam for it. Put back to the
     *  file's stand-in in the `finally` below, immediately after the call.
     */
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({
      json: async () => ({ locked: true }),
    });
    try {
      await walletModule.checkWalletLocked();
    } finally {
      globalThis.fetch = saved;
    }
    assert.ok(!dialog().classList.contains("hidden"), "dialog shown");
    assert.ok(error().classList.contains("hidden"), "old error hidden");
  });
});
