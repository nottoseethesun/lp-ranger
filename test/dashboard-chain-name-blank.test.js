"use strict";

/**
 * @file test/dashboard-chain-name-blank.test.js
 * @description The dashboard names the chain only as the server names it,
 *   in its answer to `GET /api/chain` at startup. Until then there is no
 *   name, and the position labels leave the chain out rather than show
 *   another chain's; once it has, they show the server's, before any
 *   status poll. A log line's context reads the wallet from the right of
 *   its position key, because a chain's own name may hold a dash.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

let chain;
let alerts;
let status;

before(async () => {
  chain = await import("../public/dashboard-chain.js");
  alerts = await import("../public/dashboard-alerts.js");
  status = await import("../public/dashboard-data-status.js");
  document.body.replaceChildren(
    document.importNode(
      indexHtmlDocument().getElementById("tplPosContext"),
      true,
    ),
  );
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
  it("is blank before the server names the chain, with nothing in its place", () => {
    assert.equal(chain.activeChainDisplayName(), "");
    const label = status._posLabel();
    assert.doesNotMatch(label, /PulseChain/);
    assert.doesNotMatch(label, /· {2}·|· ·/, "no empty chain segment");
    assert.match(label, /NFT #7 · 0\.30% · 0x4e44…E61A$/);
  });

  it("leaves no stray dot before the wallet in a dialog's line", () => {
    const div = document.createElement("div");
    div.innerHTML = alerts._posContextHtmlForState(
      `pulsechain-${WALLET}-${PM}-7`,
      {},
    );
    const text = div.textContent.trim();
    assert.ok(text.endsWith(WALLET), text);
    assert.ok(!text.includes("· " + WALLET), text);
  });

  it("is the server's as soon as it names the chain, before any status poll", async () => {
    /*-
     *  The label of a position opened from a bookmark is written before
     *  the first status poll, so the chain's name cannot come from the
     *  poll: it comes from the chain the server names at startup.
     */
    await learnActiveChain("pulsechain", "A Chain");
    assert.match(status._posLabel(), / · A Chain · 0x4e44…E61A$/);
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
