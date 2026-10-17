"use strict";

/**
 * @file test/dashboard-chain-name-blank.test.js
 * @description The dashboard names the chain only as the server names it.
 *   Before the first `/api/status` poll there is no name, and the position
 *   labels leave the chain out rather than show another chain's; once the
 *   poll lands they show the server's. A log line's context reads the
 *   wallet from the right of its position key, because a chain's own name
 *   may hold a dash.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

let helpers;
let status;

before(async () => {
  helpers = await import("../public/dashboard-helpers.js");
  status = await import("../public/dashboard-data-status.js");
  const store = await import("../public/dashboard-positions-store.js");
  store.posStore.entries.length = 0;
  store.posStore.entries.push({
    tokenId: "7",
    walletAddress: WALLET,
    contractAddress: PM,
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 3000,
  });
  store.posStore.activeIdx = 0;
});

describe("the chain's name in position labels", () => {
  it("is blank before the first poll, with nothing in its place", () => {
    assert.equal(helpers.botConfig.chainName, "");
    const label = status._posLabel();
    assert.doesNotMatch(label, /PulseChain/);
    assert.doesNotMatch(label, /· {2}·|· ·/, "no empty chain segment");
    assert.match(label, /NFT #7 · 0\.30% · 0x4e44…E61A$/);
  });

  it("is the server's once the poll has named it", () => {
    helpers.botConfig.chainName = "A Chain";
    try {
      assert.match(status._posLabel(), / · A Chain · 0x4e44…E61A$/);
    } finally {
      helpers.botConfig.chainName = "";
    }
  });
});

describe("a log line's position context", () => {
  it("reads the wallet from the right of a key whose chain holds a dash", () => {
    const key = `pulsechain-testnet-${WALLET}-${PM}-7`;
    const ctx = status._logCtx(key, {
      activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
    });
    assert.match(ctx, /NFT #7/);
    assert.match(ctx, /0x4e44…E61A$/, "the wallet, not the chain's 'testnet'");
  });
});
