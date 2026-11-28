"use strict";

/**
 * @file test/dashboard-first-status-unlocked-load.test.js
 * @description A page that loads while the server already holds the
 *   wallet's key, as after a launch with WALLET_PASSWORD, with an
 *   unmanaged position on screen. The details request it held back
 *   while it did not yet know the wallet was unlocked waits for the
 *   first status answer, since only an answer says whether the bot
 *   manages the position, and is sent once it is read: a managed one
 *   would be scanned by the dashboard as well as the bot
 *   (`pendingFetchStep`, src/client/web/js/dashboard-unmanaged.js).
 *
 *   The load's own lock check, finding the wallet unlocked, used to send
 *   it at once, before any answer. Driven through the page's own poll,
 *   in a process of its own, so no answer is read before.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";
const TOKEN_ID = "778";

/** An answer as the dashboard reads one, its body `body`. */
const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

const detailsAsked = [];
let poll, walletMod, unmanaged, store;
let savedFetch;

before(async () => {
  /*-
   *  TEST-ONLY global swap, put back in `after`: the dashboard asks the
   *  server through the browser's fetch. The server holds the wallet and
   *  its key, and manages no position.
   */
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "/api/status")
      return answer({
        global: {
          walletAddress: WALLET,
          walletJustChanged: null,
          importingWallet: false,
          walletUnlocked: true,
          clearWalletRefusal: null,
          managedPositions: [],
        },
        positions: {},
      });
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url === "/api/position/details") {
      detailsAsked.push(url);
      return answer({ ok: false });
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
  unmanaged = await import("../src/client/web/js/dashboard-unmanaged.js");
  store = await import("../src/client/web/js/dashboard-positions-store.js");
  // What dashboard-init.js hands the wallet module.
  walletMod.injectWalletDeps({
    flushPendingUnmanagedFetch: unmanaged.flushPendingUnmanagedFetch,
  });
});

after(() => {
  globalThis.fetch = savedFetch;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("a page loading while the server holds the key", () => {
  it("holds the details request until the first status answer, then sends it", async () => {
    await walletMod.checkServerWalletStatus();
    store.posStore.add({
      walletAddress: WALLET,
      positionType: "nft",
      tokenId: TOKEN_ID,
      token0: "0x" + "a".repeat(40),
      token1: "0x" + "b".repeat(40),
      fee: 10000,
      contractAddress: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
    });
    store.posStore.select(0);
    // Asked as the page loads, before it knows the wallet is unlocked.
    await unmanaged.fetchUnmanagedDetails(store.posStore.getActive());
    await walletMod.checkWalletLocked();
    await settled();
    assert.equal(walletMod.isWalletUnlocked(), true);
    assert.deepEqual(detailsAsked, [], "no answer read yet: it waits");
    poll.pollNow();
    await settled();
    /*-
     *  Once, not twice: the answer sends the request for the
     *  position on screen, which ends the hold, so the flush after it
     *  sends nothing. Each request is a full read of the position's
     *  history through the rpc queue.
     */
    assert.deepEqual(
      detailsAsked,
      ["/api/position/details"],
      "sent once an answer says unmanaged, and only once",
    );
  });
});
