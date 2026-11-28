"use strict";

/**
 * @file test/dashboard-start-refusal-before-lock-check.test.js
 * @description A page loaded while the server, having refused to start,
 *   waits to exit: as with a `PRIVATE_KEY` for another wallet than the
 *   one imported (src/server/server-routes.js `_refuseLaunch`). The page
 *   asks for the wallet's status and the first status answer together,
 *   and asks whether the wallet is locked only once the wallet's status
 *   has come back (src/client/web/js/dashboard-init.js). So the status
 *   answer, carrying the refusal, usually comes first, and the LP Ranger
 *   cannot start dialog shows. The lock check, answering "locked" after
 *   it, must not open the Unlock dialog beneath it: the server unlocks
 *   nothing while it waits to exit, and the refusal is shown once, so
 *   nothing would close that dialog again. The Unlock Wallet button is
 *   still painted for the locked answer, enabled for a page holding the
 *   server's wallet, disabled for one holding another.
 *
 *   Driven through the page's own poll, in a process of its own, since
 *   the page shows the refusal once.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";
const WHY =
  "PRIVATE_KEY in .env is for wallet 0x1, but the wallet imported in " +
  "LP Ranger is 0x2. Then restart the server. The server is stopping now.";

/** An answer as the dashboard reads one, its body `body`. */
const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

let poll, walletMod, refusalMod, notices;
// The wallet the server's lock check names: this page's, until a case says.
let serverWallet = WALLET;
let savedFetch;

before(async () => {
  /*-
   *  TEST-ONLY global swap, put back in `after`: the dashboard asks the
   *  server through the browser's fetch. The server holds the wallet,
   *  locked, and refuses to start.
   */
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "/api/status")
      return answer({
        global: {
          walletAddress: WALLET,
          walletJustChanged: null,
          importingWallet: false,
          walletUnlocked: false,
          clearWalletRefusal: "LP Ranger cannot start and is stopping.",
          importWalletRefusal: "LP Ranger is stopping, so nothing starts.",
          startRefusal: WHY,
          managedPositions: [],
        },
        positions: {},
      });
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: true, address: serverWallet });
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
  refusalMod = await import("../src/client/web/js/dashboard-start-refusal.js");
  notices = await import("../src/client/web/js/dashboard-app-notices.js");
  // What dashboard-init.js hands the wallet module.
  walletMod.injectWalletDeps({
    startRefusalShown: refusalMod.startRefusalShown,
  });
});

after(() => {
  globalThis.fetch = savedFetch;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const unlockOpen = () =>
  !document.getElementById("walletUnlockModal").classList.contains("hidden");

describe("a lock check answering after LP Ranger cannot start was shown", () => {
  it("opens no Unlock dialog beneath it", async () => {
    await walletMod.checkServerWalletStatus();
    poll.pollNow();
    await settled();
    assert.ok(
      document.getElementById(notices.START_REFUSAL_NOTICE_ID),
      "LP Ranger cannot start shown first",
    );
    await walletMod.checkWalletLocked();
    await settled();
    assert.equal(unlockOpen(), false, "no Unlock dialog opened");
    /*-
     *  The Unlock Wallet button is painted as for any locked answer, not
     *  left at the page's own start, "Wallet is already unlocked": once
     *  the server is started again in its place, the tab unlocks without
     *  a reload.
     */
    const button = document.getElementById("unlockWalletBtn");
    assert.equal(button.disabled, false, "the button offers an unlock");
    assert.equal(button.title, "Unlock wallet to manage positions");
  });

  it("leaves Unlock Wallet disabled on a page holding another wallet than the server's", async () => {
    /*-
     *  Such a page offers Wallet Setup alone, no unlock of a wallet it
     *  does not show, as for any locked answer naming another wallet.
     */
    serverWallet = "0x2222222222222222222222222222222222222222";
    await walletMod.checkWalletLocked();
    await settled();
    assert.equal(unlockOpen(), false, "no Unlock dialog opened");
    const button = document.getElementById("unlockWalletBtn");
    assert.equal(button.disabled, true);
    assert.equal(button.title, "No wallet to unlock");
  });

  it("is told by dashboard-init.js, as it tells the wallet module the rest", () => {
    /*-
     *  dashboard-init.js runs the whole page on import, so its wiring is
     *  read rather than run.
     */
    const src = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "src",
        "client",
        "web",
        "js",
        "dashboard-init.js",
      ),
      "utf8",
    );
    const wiring = src.slice(
      src.indexOf("injectWalletDeps({"),
      src.indexOf("injectPositionDeps({"),
    );
    assert.ok(wiring.includes("startRefusalShown,"), "handed to the module");
  });
});
