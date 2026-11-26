"use strict";

/**
 * @file test/dashboard-wallet-poll.test.js
 * @description What a status answer does to the wallet strip, driven
 *   through the page's own poll (src/client/web/js/dashboard-data.js) on
 *   its markup (src/client/web/index.html), after the page loaded its
 *   wallet locked as it does at startup.
 *
 *   Clear Wallet is disabled, the reason its tooltip, while the answer
 *   says a Clear would be refused (`clearWalletRefusal`,
 *   src/server/wallet-clear.js), and a Clear the server refuses all the
 *   same keeps the wallet and says why. A Clear it takes forgets the
 *   wallet and disables Unlock Wallet, which a tab in View-Only offered.
 *
 *   A page that showed the wallet locked shows it unlocked once an answer
 *   naming its wallet, in any letter case, says the server holds the key
 *   (`walletUnlocked`): its Unlock dialog closed, View-Only left, Unlock
 *   Wallet disabled. An answer saying the key is not held, or naming
 *   another wallet, as during an import in another tab, changes nothing;
 *   nor does the load's own locked answer arriving after it.
 *
 *   Whether the page shows the wallet unlocked is never turned back, so
 *   the cases run in order and the one that unlocks it comes late.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";
const OTHER = "0x2222222222222222222222222222222222222222";
const UNLOCKING =
  "LP Ranger is unlocking the wallet, or waiting for its password at " +
  "its terminal. Try Clear Wallet again once that has finished.";

/** An answer as the dashboard reads one, its body `body`. */
const answer = (body, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

/*-
 *  The scripted server: what its status answer says, whether the wallet
 *  is locked, and how it answers a Clear.
 */
const server = {
  walletAddress: WALLET,
  walletUnlocked: false,
  clearWalletRefusal: null,
  locked: true,
  clearAnswer: answer({ ok: true }),
};

/** The status answer the scripted server gives. */
function statusAnswer() {
  return {
    global: {
      walletAddress: server.walletAddress,
      walletJustChanged: null,
      importingWallet: false,
      walletUnlocked: server.walletUnlocked,
      clearWalletRefusal: server.clearWalletRefusal,
      managedPositions: [],
    },
    positions: {},
  };
}

let poll, walletMod, importMod;
// What the swaps below replace, put back in `after`.
let savedFetch, savedAlert;
const alerts = [];

before(async () => {
  /*-
   *  TEST-ONLY global swap: two, for this file's own process, each put
   *  back in `after`. The dashboard asks the server through the browser's
   *  fetch, and says why a Clear was refused through `alert`.
   */
  savedFetch = globalThis.fetch;
  savedAlert = globalThis.alert;
  globalThis.fetch = async (url, init = {}) => {
    if (url === "/api/status") return answer(statusAnswer());
    if (url === "/api/wallet/status")
      return answer({
        loaded: true,
        locked: server.locked,
        address: WALLET,
        source: "key",
      });
    if (url === "/api/wallet" && init.method === "DELETE")
      return server.clearAnswer;
    return answer({ ok: false });
  };
  globalThis.alert = (text) => alerts.push(text);
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  await import("../src/client/web/js/dashboard-data.js");
  poll = await import("../src/client/web/js/dashboard-data-poll.js");
  walletMod = await import("../src/client/web/js/dashboard-wallet.js");
  importMod = await import("../src/client/web/js/dashboard-wallet-import.js");
});

after(() => {
  globalThis.fetch = savedFetch;
  globalThis.alert = savedAlert;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One status poll, answered. */
async function polled() {
  poll.pollNow();
  await settled();
}

/** The page loads its wallet, locked, as at startup. */
async function pageLoadsLocked() {
  server.locked = true;
  await walletMod.checkServerWalletStatus();
  await walletMod.checkWalletLocked();
}

const clearBtn = () => document.getElementById("wsClearBtn");
const unlockBtn = () => document.getElementById("unlockWalletBtn");
const dialogOpen = () =>
  !document.getElementById("walletUnlockModal").classList.contains("hidden");

describe("Clear Wallet on a status answer", () => {
  it("is disabled, the reason its tooltip, while a Clear would be refused, and enabled after", async () => {
    await pageLoadsLocked();
    assert.equal(walletMod.wallet.address, WALLET, "the wallet loaded");
    server.clearWalletRefusal = UNLOCKING;
    await polled();
    assert.equal(clearBtn().disabled, true);
    assert.equal(clearBtn().title, UNLOCKING);
    server.clearWalletRefusal = null;
    await polled();
    assert.equal(clearBtn().disabled, false);
    assert.equal(clearBtn().title, "Clear wallet from server and browser");
  });

  it("refused by the server all the same, keeps the wallet and says why", async () => {
    // As when the click came between a status answer and an unlock.
    server.clearAnswer = answer({ ok: false, error: UNLOCKING }, 409);
    alerts.length = 0;
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, WALLET, "the wallet kept");
    assert.notEqual(clearBtn().style.display, "none", "Clear still offered");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /not cleared/);
    assert.match(alerts[0], /unlocking the wallet/);
  });

  it("taken by the server, forgets the wallet and disables Unlock Wallet", async () => {
    walletMod.dismissToViewOnly();
    assert.equal(unlockBtn().disabled, false, "View-Only offers Unlock Wallet");
    server.clearAnswer = answer({ ok: true });
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, null, "the wallet forgotten");
    assert.equal(clearBtn().style.display, "none", "Clear no longer offered");
    assert.equal(unlockBtn().disabled, true);
    assert.equal(unlockBtn().title, "No wallet to unlock");
  });
});

describe("a status answer saying whether the server holds the wallet's key", () => {
  it("changes nothing while it says the key is not held", async () => {
    await pageLoadsLocked();
    assert.ok(dialogOpen(), "the load showed the Unlock dialog");
    server.walletUnlocked = false;
    await polled();
    assert.ok(dialogOpen(), "the dialog left open");
    assert.equal(walletMod.isWalletUnlocked(), false);
  });

  it("changes nothing when it names another wallet", async () => {
    // As while another tab imports a wallet the server already holds.
    server.walletAddress = OTHER;
    server.walletUnlocked = true;
    await polled();
    assert.ok(dialogOpen(), "the dialog left open");
    assert.equal(walletMod.isWalletUnlocked(), false);
  });

  it("shows the wallet unlocked once it names this page's wallet, in any letter case", async () => {
    // View-Only, then Unlock Wallet clicked, which opens the dialog again.
    walletMod.dismissToViewOnly();
    walletMod.showUnlockDialog();
    assert.equal(walletMod.isViewOnly(), true);
    server.walletAddress = WALLET.toLowerCase();
    server.walletUnlocked = true;
    await polled();
    assert.equal(dialogOpen(), false, "the dialog closed");
    assert.equal(walletMod.isViewOnly(), false, "View-Only left");
    assert.equal(unlockBtn().disabled, true);
    assert.equal(unlockBtn().title, "Wallet is already unlocked");
    assert.equal(walletMod.isWalletUnlocked(), true);
  });

  it("is not undone by the load's locked answer arriving after it", async () => {
    server.locked = true;
    await walletMod.checkWalletLocked();
    assert.equal(dialogOpen(), false, "the dialog stays closed");
    assert.equal(unlockBtn().disabled, true, "Unlock Wallet stays disabled");
  });
});
