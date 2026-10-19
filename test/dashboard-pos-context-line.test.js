"use strict";

/**
 * @file test/dashboard-pos-context-line.test.js
 * @description The position line at the top of every dialog: the pair
 *   and its provider, the NFT and its fee tier, then the chain and the
 *   wallet. A server alert's line, which names the event's position
 *   rather than the one on screen, ran the chain into the wallet:
 *   "PulseChain0x1111…". Both lines now come from one filler
 *   (`_fillPosContext`, public/dashboard-data-status.js), so they read
 *   alike, a middle dot between the chain and the wallet.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-42`;

let alerts;
let status;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await learnActiveChain("pulsechain", "PulseChain");
  alerts = await import("../public/dashboard-alerts.js");
  status = await import("../public/dashboard-data-status.js");
  const { posStore } = await import("../public/dashboard-positions-store.js");
  posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: "42",
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 2500,
  });
  posStore.select(0);
  document.body.replaceChildren(
    document.importNode(
      indexHtmlDocument().getElementById("tplPosContext"),
      true,
    ),
  );
});

/** The text of the line an HTML string holds, without the template's margins. */
function lineText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent.trim();
}

describe("the position line in a dialog", () => {
  it("separates the chain from the wallet in a server alert", () => {
    const text = lineText(
      alerts._posContextHtmlForState(KEY, {
        activePosition: { token0Symbol: "AAA", token1Symbol: "BBB", fee: 2500 },
      }),
    );
    assert.ok(text.includes("PulseChain · " + WALLET), text);
    assert.ok(!text.includes("PulseChain0x"), text);
  });

  it("reads the same as the line for the position on screen", () => {
    const forAlert = lineText(
      alerts._posContextHtmlForState(KEY, {
        activePosition: { token0Symbol: "AAA", token1Symbol: "BBB", fee: 2500 },
      }),
    );
    assert.equal(forAlert, lineText(status._posContextHtml()));
  });

  /*-
   *  The line before the server has named the chain is
   *  test/dashboard-chain-name-blank.test.js's, since a page learns its
   *  chain once and this file has already learned it.
   */
});
