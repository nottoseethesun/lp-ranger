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
 *   An unlock the server answers with no wallet closes the dialog, shows
 *   the Wallet file not found notice, then Wallet Setup, and disables
 *   Unlock Wallet. What a status answer does to the dialog is tested in
 *   test/dashboard-wallet-poll.test.js.
 *
 *   Runs on the dashboard's own markup (src/client/web/index.html), where
 *   the dialog and its error start hidden and the button disabled.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
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
     *  status through `fetch`, and takes no seam for it. Put back in the
     *  `finally` below, immediately after the call.
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

describe("an unlock the server answers with no wallet", () => {
  it("closes the dialog and shows Wallet file not found, whose OK opens Wallet Setup", async () => {
    /*-
     *  As after a Clear in another tab since this page loaded
     *  (src/server/server-unlock.js answers 404). The dialog reopened
     *  from Unlock Wallet in View-Only, which leaves the button enabled.
     */
    const imports =
      await import("../src/client/web/js/dashboard-wallet-import.js");
    walletModule.injectWalletDeps({
      walletGoneAtUnlock: imports.walletGoneAtUnlock,
    });
    walletModule.wallet.address = "0x" + "1".repeat(40);
    walletModule.dismissToViewOnly();
    walletModule.showUnlockDialog();
    const unlock = document.getElementById("unlockWalletBtn");
    assert.equal(unlock.disabled, false, "View-Only offers Unlock Wallet");
    document.getElementById("unlockPassword").value = "pw";
    /*-
     *  TEST-ONLY global swap: the unlock posts through `fetch`, and takes
     *  no seam for it. Put back in the `finally` below.
     */
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 404,
      json: async () => ({
        ok: false,
        error: "There is no wallet to unlock. Import one first.",
      }),
    });
    try {
      await walletModule.submitUnlock();
    } finally {
      globalThis.fetch = saved;
    }
    assert.ok(dialog().classList.contains("hidden"), "Unlock dialog closed");
    assert.equal(walletModule.wallet.address, null, "the wallet forgotten");
    assert.equal(unlock.disabled, true, "nothing left to unlock");
    assert.equal(unlock.title, "No wallet to unlock");
    const notice = document.getElementById("9mm-wallet-gone-modal");
    assert.ok(notice, "Wallet file not found shown");
    notice.querySelector("[data-dismiss-modal]").click();
    assert.equal(
      document.getElementById("walletModal").className,
      "modal-overlay",
      "Wallet Setup open",
    );
  });
});

/*-
 *  An import shows the wallet unlocked, which nothing turns back, and the
 *  cases above need it locked: this one runs last.
 */
describe("a wallet imported on this page", () => {
  it("leaves Unlock Wallet disabled, though View-Only had offered it", async () => {
    walletModule.dismissToViewOnly();
    const unlock = document.getElementById("unlockWalletBtn");
    assert.equal(unlock.disabled, false, "View-Only offers Unlock Wallet");
    const key = "0x" + "ab".repeat(32);
    walletModule.wallet._pending = {
      address: "0x" + "2".repeat(40),
      privateKey: key,
      mnemonic: null,
      source: "key",
    };
    document.getElementById("keyInput").value = key;
    document.getElementById("keyPassword").value = "pw";
    document.getElementById("keyPasswordConfirm").value = "pw";
    /*-
     *  TEST-ONLY global swaps, each put back in the `finally` below: the
     *  import posts through `fetch`, and finds the password field in use
     *  by whether it is laid out (`offsetParent`), which jsdom never
     *  reports, so every element counts as laid out here.
     */
    const savedFetch = globalThis.fetch;
    const savedOffsetParent = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      "offsetParent",
    );
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: url === "/api/wallet" }),
      clone() {
        return this;
      },
    });
    Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() {
        return this.parentNode;
      },
    });
    try {
      await walletModule.confirmWallet();
    } finally {
      globalThis.fetch = savedFetch;
      Object.defineProperty(
        window.HTMLElement.prototype,
        "offsetParent",
        savedOffsetParent,
      );
    }
    assert.equal(walletModule.isWalletUnlocked(), true, "the import went in");
    assert.equal(unlock.disabled, true);
    assert.equal(unlock.title, "Wallet is already unlocked");
  });
});
