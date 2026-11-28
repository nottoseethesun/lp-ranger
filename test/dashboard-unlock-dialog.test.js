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
 *   Unlock Wallet. An unlock or Reveal Key another wallet's import
 *   overtook closes quietly, showing no error. A page whose address names
 *   another wallet than the server's offers no Unlock dialog. What a
 *   status answer does to the dialog is tested in
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
let notices;

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
  // The notices' ids, as the code that shows them and the guard read them.
  notices = await import("../src/client/web/js/dashboard-app-notices.js");
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
    // The page holds the wallet the server names, as a real answer does.
    const pageWallet = "0x" + "1".repeat(40);
    walletModule.wallet.address = pageWallet;
    /*-
     *  TEST-ONLY global swap: the check asks the server for the wallet's
     *  status through `fetch`, and takes no seam for it. Put back in the
     *  `finally` below, immediately after the call.
     */
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({
      json: async () => ({
        loaded: true,
        locked: true,
        address: pageWallet.toLowerCase(),
      }),
    });
    try {
      await walletModule.checkWalletLocked();
    } finally {
      globalThis.fetch = saved;
      walletModule.wallet.address = null;
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
    const notice = document.getElementById(notices.WALLET_GONE_NOTICE_ID);
    assert.ok(notice, "Wallet file not found shown");
    notice.querySelector("[data-dismiss-modal]").click();
    assert.equal(
      document.getElementById("walletModal").className,
      "modal-overlay",
      "Wallet Setup open",
    );
  });
});

/**
 * Run `body` with the browser's fetch answering every request with
 * `status` and `json`. TEST-ONLY global swap, put back in the `finally`.
 */
async function withAnswer(status, json, body) {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status === 200,
    status,
    json: async () => json,
    clone() {
      return this;
    },
  });
  try {
    await body();
  } finally {
    globalThis.fetch = saved;
  }
}

describe("an unlock or Reveal Key another wallet's import overtook", () => {
  /*-
   *  The decrypt was stale (src/lib/wallet-manager.js): nothing is
   *  wrong, the import goes on as normal, and the tab follows the new
   *  wallet once it has finished. So the page shows no error.
   */
  const REPLACED = {
    ok: false,
    walletReplaced: true,
    error: "Another wallet replaced this one while it was being unlocked.",
  };

  it("closes the Unlock dialog quietly, the password emptied", async () => {
    walletModule.wallet.address = "0x" + "1".repeat(40);
    walletModule.showUnlockDialog();
    document.getElementById("unlockPassword").value = "pw";
    await withAnswer(409, REPLACED, () => walletModule.submitUnlock());
    assert.ok(dialog().classList.contains("hidden"), "dialog closed");
    assert.ok(error().classList.contains("hidden"), "no error shown");
    assert.equal(document.getElementById("unlockPassword").value, "");
  });

  it("closes Reveal Key quietly, nothing revealed", async () => {
    const imports =
      await import("../src/client/web/js/dashboard-wallet-import.js");
    document.getElementById("revealModal").className = "modal-overlay";
    document.getElementById("revealPassword").value = "pw";
    await withAnswer(409, REPLACED, () => imports.revealWallet());
    assert.match(document.getElementById("revealModal").className, /hidden/);
    assert.notEqual(
      document.getElementById("revealError").style.display,
      "block",
      "no error shown",
    );
    assert.equal(document.getElementById("revealPassword").value, "");
  });
});

describe("a page whose address names another wallet than the server's", () => {
  it("offers Wallet Setup alone, no Unlock dialog, the server's wallet locked", async () => {
    /*-
     *  The page follows its address, not the server, so it holds no
     *  wallet (`_restoreServerWallet`); the lock check, run after it as
     *  the page loads, finds the server's wallet is not the page's.
     */
    // A page that has just loaded holds no wallet yet.
    walletModule.wallet.address = null;
    walletModule.injectWalletDeps({
      getPendingRouteWallet: () => "0x" + "2".repeat(40),
    });
    const server = {
      loaded: true,
      locked: true,
      address: "0x" + "1".repeat(40),
    };
    try {
      await withAnswer(200, server, async () => {
        await walletModule.checkServerWalletStatus();
        await walletModule.checkWalletLocked();
      });
    } finally {
      walletModule.injectWalletDeps({ getPendingRouteWallet: () => null });
    }
    assert.equal(walletModule.wallet.address, null, "no wallet on the page");
    assert.equal(
      document.getElementById("walletModal").className,
      "modal-overlay",
      "Wallet Setup open",
    );
    assert.ok(dialog().classList.contains("hidden"), "no Unlock dialog");
    const unlock = document.getElementById("unlockWalletBtn");
    assert.equal(unlock.disabled, true);
    assert.equal(unlock.title, "No wallet to unlock");
  });

  it("runs the lock check only once the wallet check has answered, as the page loads", () => {
    /*-
     *  Run side by side, the lock check could answer first and open the
     *  Unlock dialog before the page knew which wallet it shows.
     */
    const fs = require("node:fs");
    const path = require("node:path");
    const init = fs.readFileSync(
      path.join(__dirname, "..", "src/client/web/js/dashboard-init.js"),
      "utf8",
    );
    assert.match(
      init,
      /walletStatusChecked\.then\(\(\) => checkWalletLocked\(\)\)/,
    );
    assert.doesNotMatch(init, /^\s*checkWalletLocked\(\);/m);
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
