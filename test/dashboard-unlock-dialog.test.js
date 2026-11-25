"use strict";

/**
 * @file test/dashboard-unlock-dialog.test.js
 * @description The unlock dialog opens with no error left from an earlier
 *   try (`showUnlockDialog`, src/client/web/js/dashboard-wallet.js). A
 *   wrong password shown when the operator dismissed the dialog to view
 *   only would otherwise greet the next unlock. The Unlock Wallet button
 *   opens it through the same function (src/client/web/js/dashboard-events.js),
 *   and so does the check that finds the wallet locked, run here through
 *   a stand-in for the server.
 *
 *   Runs on the dashboard's own markup (src/client/web/index.html), where
 *   the dialog and its error start hidden.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");

let walletModule;

const dialog = () => document.getElementById("walletUnlockModal");
const error = () => document.getElementById("unlockError");

/** Show an error from an earlier try, then dismiss the dialog. */
function leaveAnErrorBehind() {
  dialog().classList.remove("hidden");
  error().textContent = "Wrong password";
  error().classList.remove("hidden");
  walletModule.dismissToViewOnly();
  assert.ok(dialog().classList.contains("hidden"), "dismissed");
}

before(async () => {
  walletModule = await import("../src/client/web/js/dashboard-wallet.js");
});

beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
});

describe("the unlock dialog", () => {
  it("opens with the error from an earlier try hidden", () => {
    leaveAnErrorBehind();
    walletModule.showUnlockDialog();
    assert.ok(!dialog().classList.contains("hidden"), "dialog shown");
    assert.ok(error().classList.contains("hidden"), "old error hidden");
  });

  it("opens the same way when the wallet is found locked", async () => {
    leaveAnErrorBehind();
    /*-
     *  TEST-ONLY global swap: the check asks the server for the wallet's
     *  status through `fetch`, and takes no seam for it. Restored
     *  pristine in the `finally` below, immediately after the call.
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
