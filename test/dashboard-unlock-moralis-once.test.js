"use strict";

/**
 * @file test/dashboard-unlock-moralis-once.test.js
 * @description A page that loads while the server already holds the
 *   wallet's key checks the stored Moralis key once, however its two
 *   ways of learning the wallet is unlocked come: the first status answer
 *   (`showUnlockedIfServerIs`) and the load's own lock check
 *   (`checkWalletLocked`), src/client/web/js/dashboard-wallet.js. When
 *   the answer came first, the lock check used to run the check again,
 *   and a bad key was announced twice in the Activity Log.
 *
 *   Driven through the page's own poll, in a process of its own, since a
 *   page never shows the wallet locked again once it has shown it
 *   unlocked.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";

/** An answer as the dashboard reads one, its body `body`. */
const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

// Each check of the stored Moralis key the page asks for.
const moralisChecks = [];
let poll, walletMod;
let savedFetch;

before(async () => {
  /*-
   *  TEST-ONLY global swap, put back in `after`: the dashboard asks the
   *  server through the browser's fetch. The server holds the wallet and
   *  its key, and its stored Moralis key fails validation.
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
          importWalletRefusal: null,
          managedPositions: [],
        },
        positions: {},
      });
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url === "/api/api-keys/status") {
      moralisChecks.push(url);
      return answer({ moralis: "invalid" });
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
});

after(() => {
  globalThis.fetch = savedFetch;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("a page learning from a status answer, then its lock check, that the wallet is unlocked", () => {
  it("checks the Moralis key once, and says a bad one once", async () => {
    await walletMod.checkServerWalletStatus();
    poll.pollNow();
    await settled();
    assert.equal(walletMod.isWalletUnlocked(), true, "the answer unlocked it");
    assert.equal(moralisChecks.length, 1, "checked as the answer unlocked it");
    await walletMod.checkWalletLocked();
    await settled();
    assert.equal(moralisChecks.length, 1, "not again for the lock check");
    const said = document.body.textContent.split("Moralis Key Invalid");
    assert.equal(said.length - 1, 1, "a bad key said once");
  });
});
