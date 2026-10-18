"use strict";

/**
 * @file test/position-rangeW.test.js
 * @description The out-of-range threshold the dashboard keeps in the
 *   browser for each position, saved and loaded through the real
 *   `savePositionOorThreshold` / `loadPositionOorThreshold` in
 *   `public/dashboard-helpers.js`, under jsdom's `localStorage`.
 *
 *   The value is keyed by everything that tells one position from
 *   another: the chain, the wallet, the position's contract and, for an
 *   NFT, its number. Two positions sharing an NFT number under another
 *   contract, wallet or chain must not share a threshold, and until the
 *   chain is known nothing is read or written at all, since a key built
 *   without it would be one of those shared ones.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let helpers;
let chainMod;

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const OTHER_PM = "0x2222222222222222222222222222222222222222";
const nft = (overrides) => ({
  positionType: "nft",
  walletAddress: WALLET,
  contractAddress: PM,
  tokenId: "100",
  ...overrides,
});

/** Every key the browser's storage holds, in order. */
function storedKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return keys;
}

/** Have the dashboard learn `chainId` the way startup does. */
function learnChain(chainId) {
  return chainMod.loadActiveChain({
    fetchFn: async () => ({ ok: true, json: async () => ({ chainId }) }),
    onUnanswered: () => {},
    onAnswered: () => {},
  });
}

before(async () => {
  chainMod = await import("../public/dashboard-chain.js");
  helpers = await import("../public/dashboard-helpers.js");
});

beforeEach(() => localStorage.clear());

describe("before the server has named the chain", () => {
  it("neither saves nor loads, so no key lacks the chain", () => {
    assert.equal(chainMod.activeChainId(), null);
    helpers.savePositionOorThreshold(nft(), 15);
    assert.equal(localStorage.length, 0);
    assert.equal(helpers.loadPositionOorThreshold(nft()), undefined);
  });
});

describe("once the chain is known", () => {
  before(() => learnChain("pulsechain"));

  it("saves and loads a position's threshold", () => {
    helpers.savePositionOorThreshold(nft(), 15);
    assert.equal(helpers.loadPositionOorThreshold(nft()), 15);
  });

  it("keys it by chain, wallet, contract and NFT number", () => {
    helpers.savePositionOorThreshold(nft(), 15);
    assert.deepEqual(storedKeys(), [
      "9mm_oorThreshold_nft_pulsechain_" +
        WALLET.toLowerCase() +
        "_" +
        PM.toLowerCase() +
        "_100",
    ]);
  });

  it("keeps apart two positions with one NFT number under two contracts", () => {
    helpers.savePositionOorThreshold(nft(), 10);
    helpers.savePositionOorThreshold(nft({ contractAddress: OTHER_PM }), 30);
    assert.equal(helpers.loadPositionOorThreshold(nft()), 10);
    assert.equal(
      helpers.loadPositionOorThreshold(nft({ contractAddress: OTHER_PM })),
      30,
    );
  });

  it("keys an ERC-20 position by its LP token, with no NFT number", () => {
    const lp = {
      positionType: "erc20",
      walletAddress: WALLET,
      contractAddress: OTHER_PM,
    };
    helpers.savePositionOorThreshold(lp, 12.5);
    assert.equal(helpers.loadPositionOorThreshold(lp), 12.5);
    assert.deepEqual(storedKeys(), [
      "9mm_oorThreshold_erc20_pulsechain_" +
        WALLET.toLowerCase() +
        "_" +
        OTHER_PM.toLowerCase(),
    ]);
  });

  it("saves nothing for a position missing a field of its key", () => {
    for (const pos of [
      null,
      nft({ walletAddress: undefined }),
      nft({ contractAddress: "" }),
      nft({ tokenId: 100 }),
    ]) {
      helpers.savePositionOorThreshold(pos, 15);
      assert.equal(helpers.loadPositionOorThreshold(pos), undefined);
    }
    assert.equal(localStorage.length, 0);
  });

  it("loads nothing for a stored value that is not a positive number", () => {
    helpers.savePositionOorThreshold(nft(), 15);
    const [key] = storedKeys();
    for (const bad of ["not-a-number", "0", "-5"]) {
      localStorage.setItem(key, bad);
      assert.equal(helpers.loadPositionOorThreshold(nft()), undefined);
    }
  });

  it("overwrites an earlier value", () => {
    helpers.savePositionOorThreshold(nft(), 10);
    helpers.savePositionOorThreshold(nft(), 25);
    assert.equal(helpers.loadPositionOorThreshold(nft()), 25);
  });
});
