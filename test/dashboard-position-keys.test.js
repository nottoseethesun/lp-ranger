"use strict";

/**
 * @file test/dashboard-position-keys.test.js
 * @description Every figure the browser keeps for one position or pool
 *   is stored under a key naming the chain, the wallet and the position's
 *   contract, as well as the NFT number or the pool.
 *
 *   The Current panel's deposit and realized-gains figures were kept
 *   under the NFT number alone, so two positions sharing an NFT number,
 *   or the same pair under another wallet, contract or chain, would have
 *   shared them. The user, 2026-10-17: "all such values need to be
 *   stored under a fully-qualified key". Driven through the real modules
 *   under jsdom, once the dashboard has learned its chain the way startup
 *   does; until then no such key is built at all. (The price override is
 *   kept by the server alone: test/dashboard-price-override-dialog.test.js.)
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const OTHER_PM = "0x2222222222222222222222222222222222222222";
const T0 = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
const T1 = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";

let chainMod;
let deposit;
let store;

before(async () => {
  chainMod = await import("../public/dashboard-chain.js");
  deposit = await import("../public/dashboard-data-deposit.js");
  store = await import("../public/dashboard-positions-store.js");
});

beforeEach(() => {
  localStorage.clear();
  store.posStore.entries.length = 0;
  store.posStore.activeIdx = -1;
});

/** Make `entry` the active position. */
function activate(entry) {
  store.posStore.entries.push({
    positionType: "nft",
    walletAddress: WALLET,
    contractAddress: PM,
    tokenId: "162249",
    token0: T0,
    token1: T1,
    fee: 10000,
    ...entry,
  });
  store.posStore.activeIdx = store.posStore.entries.length - 1;
}

describe("before the server has named the chain", () => {
  it("builds no position key at all", () => {
    assert.equal(chainMod.activeChainId(), null);
    assert.equal(
      deposit._posKeyFrom("9mm_deposit_pos_", WALLET, PM, "162249"),
      null,
    );
  });
});

describe("once the chain is known", () => {
  // The testnet, not the shipped default, so a key naming that outright fails.
  before(() =>
    chainMod.loadActiveChain({
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ chainId: "pulsechain-testnet" }),
      }),
      onUnanswered: () => {},
      onAnswered: () => {},
    }),
  );

  it("keys a Current-panel figure by chain, wallet, contract and NFT number", () => {
    assert.equal(
      deposit._posKeyFrom("9mm_deposit_pos_", WALLET, PM, "162249"),
      "9mm_deposit_pos_pulsechain-testnet_" +
        WALLET.toLowerCase() +
        "_" +
        PM.toLowerCase() +
        "_162249",
    );
  });

  it("gives two positions sharing an NFT number under two contracts two keys", () => {
    assert.notEqual(
      deposit._posKeyFrom("9mm_realized_pos_", WALLET, PM, "7"),
      deposit._posKeyFrom("9mm_realized_pos_", WALLET, OTHER_PM, "7"),
    );
  });

  it("builds no key for a position missing a field of it", () => {
    for (const [w, c, id] of [
      [undefined, PM, "7"],
      [WALLET, "", "7"],
      [WALLET, PM, 7],
      [WALLET, PM, ""],
    ])
      assert.equal(deposit._posKeyFrom("9mm_deposit_pos_", w, c, id), null);
  });

  it("reads the active position's figure under its full key", () => {
    /*-
     *  Through the Current panel's own readers. The keys older releases
     *  wrote, the NFT number alone, hold other figures, so a reader that
     *  looked there fails.
     */
    activate({});
    const full = `pulsechain-testnet_${WALLET.toLowerCase()}_${PM.toLowerCase()}_162249`;
    localStorage.setItem(`9mm_deposit_pos_${full}`, "250");
    localStorage.setItem("9mm_deposit_pos_162249", "999");
    localStorage.setItem(`9mm_realized_pos_${full}`, "75");
    localStorage.setItem("9mm_realized_pos_162249", "888");
    assert.equal(deposit.loadCurDeposit(), 250);
    assert.equal(deposit.loadCurRealized(), 75);
  });
});
