"use strict";

/**
 * @file test/dashboard-router-deep-link.test.js
 * @description A deep link to a position, `/<chain>/<wallet>/<contract>/<tokenId>`,
 *   opened with that wallet loaded, through src/client/web/dashboard-router.js.
 *
 *   A position the browser's store already holds is activated at once,
 *   with no scan. One the store has never seen, as in a fresh browser, is
 *   looked for once more after one wallet scan; a position that scan does
 *   not find is not in this wallet, so nothing is activated and nothing
 *   is retried.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");

const WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

let router;
let calls;
let store;

/** A store entry for the NFT `tokenId`. */
const nft = (tokenId) => ({ positionType: "nft", tokenId });

/**
 * Open the deep link to `tokenId` with the store holding `entries`, and a
 * scan that adds `found` to the store when it finishes.
 * @returns {Promise<void>} Settles once the scan, if any, has finished.
 */
function openLink(tokenId, entries, found = []) {
  const posStore = { entries: [...entries], count: () => entries.length };
  store = posStore;
  let scanDone = Promise.resolve();
  router.injectRouterDeps({
    posStore,
    wallet: { address: WALLET },
    activateByTokenId: (id) => calls.activated.push(id),
    scanPositions: () => {
      calls.scans += 1;
      scanDone = Promise.resolve().then(() => posStore.entries.push(...found));
      return scanDone;
    },
  });
  window.history.pushState(
    {},
    "",
    `/pulsechain/${WALLET}/${CONTRACT}/${tokenId}`,
  );
  router.initRouter();
  return scanDone.then(() => new Promise((r) => setImmediate(r)));
}

before(async () => {
  await learnActiveChain("pulsechain");
  router = await import("../src/client/web/dashboard-router.js");
});

beforeEach(() => {
  calls = { activated: [], scans: 0 };
});

describe("a deep link to a position", () => {
  it("activates a stored position at once, without a scan", async () => {
    await openLink("123", [nft("123")]);
    assert.deepEqual(calls.activated, ["123"]);
    assert.equal(calls.scans, 0);
  });

  it("scans once for a position the store has not seen, then activates it", async () => {
    await openLink("456", [], [nft("456")]);
    assert.equal(calls.scans, 1);
    assert.deepEqual(calls.activated, ["456"]);
  });

  it("activates nothing, and retries nothing, when the scan does not find it", async (t) => {
    /*-
     *  The position reaches the store later, and an hour of the router's
     *  timers then runs out, so a second look on a clock would activate
     *  it, and a second scan would show in the count.
     *
     *  TEST-ONLY global swap: a retry on a clock would use the router's
     *  own timers, which take no clock to hand them. The test runner
     *  puts the timers back pristine as this case ends.
     */
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    await openLink("789", [nft("1")], [nft("2")]);
    store.entries.push(nft("789"));
    t.mock.timers.tick(60 * 60 * 1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.scans, 1);
    assert.deepEqual(calls.activated, []);
  });
});

describe("the URL the dashboard writes", () => {
  /*-
   *  Both addresses EIP-55 checksummed, whatever case the store holds
   *  them in. They were written all lowercase.
   */
  const CHECKSUMMED_WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";

  beforeEach(async () => {
    window.history.pushState({}, "", "/");
    router.injectRouterDeps({
      posStore: { entries: [], count: () => 0 },
      wallet: { address: CHECKSUMMED_WALLET.toLowerCase() },
      activateByTokenId: () => {},
      scanPositions: () => Promise.resolve(),
    });
    router.initRouter();
  });

  it("checksums the wallet and the contract in a position's URL", () => {
    router.updateRouteForPosition({
      positionType: "nft",
      tokenId: "7",
      contractAddress: CONTRACT.toLowerCase(),
    });
    assert.equal(
      window.location.pathname,
      `/pulsechain/${CHECKSUMMED_WALLET}/${CONTRACT}/7`,
    );
  });

  it("checksums the wallet in a wallet's URL", () => {
    router.updateRouteForWallet(CHECKSUMMED_WALLET.toLowerCase());
    assert.equal(window.location.pathname, `/pulsechain/${CHECKSUMMED_WALLET}`);
  });
});
