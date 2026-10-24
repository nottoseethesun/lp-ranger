/**
 * @file test/position-store-erc20.test.js
 * @description Tests for ERC-20 duplicate detection in position-store.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPositionStore } = require("../src/lib/position-store");

const ERC = {
  positionType: "erc20",
  contractAddress: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
  walletAddress: "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
  walletSource: "key",
  token0: "WPLS",
  token1: "DAI",
  fee: 500,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 5000n,
};

describe("position-store ERC-20 duplicate detection", () => {
  it("detects ERC-20 duplicate by contractAddress", () => {
    const store = createPositionStore();
    store.add(ERC);
    store.add(ERC); // same contractAddress → should update, not duplicate
    assert.strictEqual(store.count(), 1);
  });

  it("does not match ERC-20 against NFT", () => {
    const store = createPositionStore();
    store.add(ERC);
    store.add({
      positionType: "nft",
      tokenId: "1",
      walletAddress: ERC.walletAddress,
      walletSource: "key",
      token0: "WPLS",
      token1: "DAI",
      fee: 500,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 100n,
    });
    assert.strictEqual(store.count(), 2);
  });
});
