"use strict";

/**
 * @file test/dashboard-price-override-dialog.test.js
 * @description The Price Override dialog opens with the override the
 *   server keeps under the key of the position on screen, as the last
 *   status answer carries it. Another position's override, or the prices
 *   another position was last shown at, never fill it.
 *
 *   The server is the only home of the override (`POST /api/config`,
 *   under the position's fully-qualified key), so the dialog shows it in
 *   any browser and after Clear Local Storage. Driven on the page's own
 *   markup from src/client/web/index.html, with the status answer scripted.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const A = {
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId: "101",
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "a2".repeat(20),
  fee: 2500,
  liquidity: "1000",
};
const B = { ...A, tokenId: "202" };
const keyOf = (p) => `pulsechain-${WALLET}-${PM}-${p.tokenId}`;

/** The status answer: only A has an override saved. */
const STATUS = {
  global: { walletAddress: WALLET, managedPositions: [] },
  positions: {
    [keyOf(A)]: {
      priceOverride0: 1.5,
      priceOverride1: 0,
      priceOverrideForce: true,
    },
  },
};

let store, override, poll;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return { ok: true, json: async () => STATUS };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  store = await import("../src/client/web/dashboard-positions-store.js");
  override = await import("../src/client/web/dashboard-price-override.js");
  await import("../src/client/web/dashboard-data.js");
  poll = await import("../src/client/web/dashboard-data-poll.js");
  store.posStore.add(A);
  store.posStore.add(B);
});

const select = (p) =>
  store.posStore.select(
    store.posStore.entries.findIndex((e) => e.tokenId === p.tokenId),
  );

/** Ask for the status, and let its answer land. */
async function answered() {
  poll.pollNow();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const input0 = () => document.getElementById("priceOverrideInput0").value;
const forced = () => document.getElementById("priceOverrideForce").checked;

describe("the Price Override dialog", () => {
  it("opens with the override the server keeps for the position", async () => {
    select(A);
    await answered();
    override.openPriceOverrideDialog();
    assert.equal(input0(), "1.5");
    assert.equal(forced(), true);
  });

  it("opens empty for a position with none, whatever another has", async () => {
    select(B);
    // The prices A was last shown at, which are not B's.
    override.setLastPrices(A, 7, 8);
    await answered();
    override.openPriceOverrideDialog();
    assert.equal(input0(), "");
    assert.equal(forced(), false);
  });

  it("shows none of the last position's just after a switch", async () => {
    select(A);
    await answered();
    // Switched, and the next answer has not landed.
    select(B);
    override.openPriceOverrideDialog();
    assert.equal(input0(), "");
    assert.equal(forced(), false);
  });
});
