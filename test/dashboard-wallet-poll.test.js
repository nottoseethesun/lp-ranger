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
 *   src/server/wallet-clear.js). A Clear the server does not confirm,
 *   refused all the same, unanswered or answered with an error, keeps
 *   the wallet and says why in the Wallet not cleared dialog, whose OK
 *   closes it. A Clear it takes forgets the wallet and disables Unlock
 *   Wallet, which a tab in View-Only offered, and shows what the server
 *   could not remove in the Wallet cleared: finish by hand dialog. The
 *   Import Wallet buttons are disabled, the reason their tooltip, while
 *   the answer says an import would be refused (`importWalletRefusal`).
 *
 *   A page that showed the wallet locked shows it unlocked once an answer
 *   naming its wallet, in any letter case, says the server holds the key
 *   (`walletUnlocked`): its Unlock dialog closed, a password typed there
 *   but never sent emptied, View-Only left, Unlock Wallet disabled. An
 *   answer saying the key is not held, or naming another wallet, as
 *   during an import in another tab, changes nothing; nor does the load's
 *   own locked answer arriving after it. An answer saying the server
 *   refuses to start (`startRefusal`) shows why in a dialog, once, and
 *   closes the Unlock dialog.
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
  "LP Ranger is decrypting the wallet, to unlock it or to reveal its key, " +
  "or waiting for the wallet's password at the terminal it was started " +
  "from. Try Clear Wallet again once that has finished.";

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
  importWalletRefusal: null,
  startRefusal: null,
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
      importWalletRefusal: server.importWalletRefusal,
      startRefusal: server.startRefusal,
      managedPositions: [],
    },
    positions: {},
  };
}

let poll, walletMod, importMod, notices;
// What the swap below replaces, put back in `after`.
let savedFetch;

before(async () => {
  /*-
   *  TEST-ONLY global swap, for this file's own process, put back in
   *  `after`: the dashboard asks the server through the browser's fetch.
   *  A Clear's answer of `null` stands for a server that cannot be
   *  reached, whose fetch throws.
   */
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (url === "/api/status") return answer(statusAnswer());
    if (url === "/api/wallet/status")
      return answer({
        loaded: true,
        locked: server.locked,
        address: WALLET,
        source: "key",
      });
    if (url === "/api/wallet" && init.method === "DELETE") {
      if (server.clearAnswer === null) throw new TypeError("Failed to fetch");
      return server.clearAnswer;
    }
    return answer({ ok: false });
  };
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
  // The notices' ids, as the code that shows them and the guard read them.
  notices = await import("../src/client/web/js/dashboard-app-notices.js");
});

after(() => {
  globalThis.fetch = savedFetch;
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
const notCleared = () =>
  document.getElementById(notices.WALLET_NOT_CLEARED_NOTICE_ID);
// The reason the Wallet not cleared dialog gives, which must be on screen.
const notClearedReason = () =>
  notCleared().querySelector('[data-tpl="reason"]').textContent;
const notClearedHeading = () =>
  notCleared().querySelector('[data-tpl="heading"]').textContent;
// Its OK, as the operator clicks it, which must close it.
function dismissNotCleared() {
  notCleared().querySelector("[data-dismiss-modal]").click();
  assert.equal(notCleared(), null, "OK closes the Wallet not cleared dialog");
}
const clearedLeft = () =>
  document.getElementById(notices.WALLET_CLEARED_LEFT_NOTICE_ID);
const activityText = () => document.body.textContent;

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

  it("refused by the server all the same, keeps the wallet and says why in a dialog", async () => {
    // As when the click came between a status answer and an unlock.
    server.clearAnswer = answer({ ok: false, error: UNLOCKING }, 409);
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, WALLET, "the wallet kept");
    assert.notEqual(clearBtn().style.display, "none", "Clear still offered");
    assert.equal(notClearedReason(), `${UNLOCKING} Nothing was changed.`);
    assert.equal(notClearedHeading(), "Wallet not cleared");
    assert.match(activityText(), /Wallet Not Cleared/);
    dismissNotCleared();
  });

  it("that gets no answer, keeps the wallet and says the page cannot tell what happened", async () => {
    /*-
     *  A server stopped partway through a Clear may have removed the
     *  wallet already, so the page does not say nothing was changed.
     */
    server.clearAnswer = null;
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, WALLET, "the wallet kept");
    assert.match(
      notClearedReason(),
      /^No answer came from the server, so this page cannot tell whether the wallet was cleared\./,
    );
    assert.match(notClearedReason(), /reload the page/);
    // Its heading and Activity entry say the same, not "not cleared".
    assert.equal(notClearedHeading(), "Clear Wallet: no answer");
    assert.match(activityText(), /Clear Wallet: No Answer/);
    dismissNotCleared();
  });

  it("answered with an error, keeps the wallet and says to reload", async () => {
    server.clearAnswer = answer({ ok: false, error: "boom" }, 500);
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, WALLET, "the wallet kept");
    assert.match(notClearedReason(), /an error \(500: boom\)/);
    assert.match(notClearedReason(), /Reload the page/);
    // Answered, after the unanswered Clear above: headed as answered again.
    assert.equal(notClearedHeading(), "Wallet not cleared");
    dismissNotCleared();
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
    assert.equal(clearedLeft(), null, "nothing left to finish by hand");
  });

  it("taken by the server with something it could not remove, says what to finish by hand", async () => {
    // As with a read-only .env, or a key set in the shell.
    const LEFT = [
      "/srv/lp-ranger/.env could not be rewritten (EROFS). Remove its PRIVATE_KEY line by hand, or the next start reads it again.",
      "WALLET_PASSWORD came from the environment the server was started from (the shell or a service manager), not .env. Remove it there too, or the next start reads it again.",
    ];
    server.clearAnswer = answer({ ok: true, warnings: LEFT });
    await importMod.confirmClearWallet();
    assert.equal(walletMod.wallet.address, null, "the wallet forgotten");
    const paragraphs = [
      ...clearedLeft().querySelectorAll('[data-tpl="warnings"] p'),
    ].map((p) => p.textContent);
    assert.deepEqual(paragraphs, LEFT, "one paragraph for each");
    assert.match(activityText(), /Wallet Cleared: Finish by Hand/);
    clearedLeft().querySelector("[data-dismiss-modal]").click();
    assert.equal(clearedLeft(), null, "OK closes it");
  });
});

describe("the Import Wallet buttons on a status answer", () => {
  /*-
   *  Each sits in a fieldset of its own, whose `disabled` adds to the
   *  button's own: the checks of what was typed set the button's, and
   *  the server's refusal (`importWalletRefusal`) sets the fieldset's.
   */
  const IDS = ["seedImportBtn", "keyImportBtn", "genConfirmBtn"];
  const REFUSAL =
    "LP Ranger is rebalancing WPLS/DAI NFT #157149. Try the import again once it has finished.";

  it("sit each in a fieldset of its own", () => {
    for (const id of IDS) {
      const gate = document.getElementById(id).parentElement;
      assert.equal(gate.tagName, "FIELDSET", id);
      assert.ok(gate.classList.contains("9mm-pos-mgr-import-gate"), id);
    }
  });

  it("are disabled, the reason their tooltip, while an import would be refused, leaving their own checks as they were", async () => {
    // As when what was typed passed its checks.
    document.getElementById("keyImportBtn").disabled = false;
    server.importWalletRefusal = REFUSAL;
    await polled();
    for (const id of IDS) {
      const btn = document.getElementById(id);
      assert.equal(btn.parentElement.disabled, true, id);
      assert.equal(btn.title, REFUSAL, id);
    }
    assert.equal(
      document.getElementById("keyImportBtn").disabled,
      false,
      "its own check's answer kept",
    );
    server.importWalletRefusal = null;
    await polled();
    for (const id of IDS) {
      const btn = document.getElementById(id);
      assert.equal(btn.parentElement.disabled, false, id);
      assert.equal(btn.title, "", id);
    }
    assert.equal(document.getElementById("keyImportBtn").disabled, false);
    assert.equal(document.getElementById("seedImportBtn").disabled, true);
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
    /*-
     *  View-Only, then Unlock Wallet clicked, which opens the dialog
     *  again; a password typed there, shown, never sent, as when another
     *  tab unlocked first.
     */
    walletMod.dismissToViewOnly();
    walletMod.showUnlockDialog();
    assert.equal(walletMod.isViewOnly(), true);
    const pw = document.getElementById("unlockPassword");
    pw.value = "typed, never sent";
    pw.type = "text";
    server.walletAddress = WALLET.toLowerCase();
    server.walletUnlocked = true;
    await polled();
    assert.equal(dialogOpen(), false, "the dialog closed");
    assert.equal(pw.value, "", "the tab keeps no copy of the password");
    assert.equal(pw.type, "password", "hidden again");
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

describe("a status answer saying the server refuses to start", () => {
  const WHY =
    "PRIVATE_KEY in .env is for wallet 0x1, but the wallet imported in " +
    "LP Ranger is 0x2. Then restart the server. The server is stopping now.";
  const refusalDialog = () =>
    document.getElementById(notices.START_REFUSAL_NOTICE_ID);

  it("shows why in a dialog, once, and in the Activity Log, closing the Unlock dialog", async () => {
    // The server unlocks nothing while it waits to exit.
    walletMod.showUnlockDialog();
    assert.ok(dialogOpen(), "the Unlock dialog open");
    server.startRefusal = WHY;
    await polled();
    assert.equal(
      refusalDialog().querySelector('[data-tpl="reason"]').textContent,
      WHY,
    );
    assert.equal(dialogOpen(), false, "the Unlock dialog closed");
    assert.match(activityText(), /LP Ranger Cannot Start/);
    refusalDialog().querySelector("[data-dismiss-modal]").click();
    assert.equal(refusalDialog(), null, "OK closes it");
    await polled();
    assert.equal(refusalDialog(), null, "not shown again for the same refusal");
  });
});
