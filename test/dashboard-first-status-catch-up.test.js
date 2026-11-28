"use strict";

/**
 * @file test/dashboard-first-status-catch-up.test.js
 * @description A page that loaded with the wallet locked, a managed
 *   position on screen, gets its first status answer, which says the
 *   server now holds the key. The page shows the wallet unlocked, and
 *   the details request it held back for the position while locked is
 *   not sent: the answer it has read says the bot manages the position,
 *   and the dashboard must not scan a position the bot owns
 *   (`pendingFetchStep`, src/client/web/js/dashboard-unmanaged.js).
 *
 *   The status handler reads the answer before it shows the wallet
 *   unlocked (`_statusAnswered`, src/client/web/js/dashboard-data.js).
 *   Shown first, the unlocked wallet sent the held request before any
 *   answer was read, as for an unmanaged position. Driven through the
 *   page's own poll, in a process of its own, so no answer is read before.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";
const TOKEN_ID = "777";

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
   *  server through the browser's fetch. The server holds the wallet,
   *  locked as the page loads, and its first status answer says it holds
   *  the key and manages the position.
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
          managedPositions: [{ tokenId: TOKEN_ID, status: "running" }],
        },
        positions: {},
      });
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: true, address: WALLET });
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

/**
 * The dashboard's log lines written while `fn` runs.
 *
 * TEST-ONLY global swap: the dashboard's log writes through
 * `console.log` and `console.info` (src/client/web/js/dashboard-log.js),
 * read here and put back in the `finally`.
 */
async function logLinesDuring(fn) {
  const lines = [];
  const saved = { log: console.log, info: console.info };
  // Formatted as a console formats them: `%s` filled, `%c` styles dropped.
  console.log = (...args) => lines.push(util.format(...args));
  console.info = (...args) => lines.push(util.format(...args));
  try {
    await fn();
  } finally {
    console.log = saved.log;
    console.info = saved.info;
  }
  return lines;
}

describe("the first status answer, saying the server holds the key", () => {
  it("shows the wallet unlocked and sends no details request for a managed position", async () => {
    await walletMod.checkServerWalletStatus();
    await walletMod.checkWalletLocked();
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
    const held = await logLinesDuring(() =>
      unmanaged.fetchUnmanagedDetails(store.posStore.getActive()),
    );
    assert.ok(
      held.some((l) => l.includes(`ENTRY-SKIP #${TOKEN_ID} wallet-locked`)),
      "held back while locked",
    );
    assert.deepEqual(detailsAsked, [], "nothing sent while locked");
    /*-
     *  The flush must decide on the request it held, and skip it: a
     *  request never held would send nothing too.
     */
    const answered = await logLinesDuring(async () => {
      poll.pollNow();
      await settled();
    });
    assert.equal(walletMod.isWalletUnlocked(), true, "shown unlocked");
    assert.ok(
      answered.some((l) => l.includes(`FLUSH-SKIP managed #${TOKEN_ID}`)),
      "the held request skipped, the bot managing the position",
    );
    assert.deepEqual(detailsAsked, [], "the bot owns it: never sent");
  });
});
