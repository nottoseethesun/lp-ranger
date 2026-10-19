"use strict";

/**
 * @file test/dashboard-il-debug-switch.test.js
 * @description The IL/G popover shows only the figures of the position on
 *   screen. Its figures arrive with the position's answer: a managed
 *   position's status poll, or an unmanaged one's details when they carry
 *   a baseline. When another position comes on screen, the popover open
 *   for the one before closes and its figures go, so a position whose
 *   answer brings none, such as an unmanaged one with no baseline, opens
 *   no popover rather than the previous position's figures under its own
 *   token names. Choosing the position already on screen keeps them,
 *   since an unmanaged position's details are not asked for again.
 *
 *   Driven through the page's own switch (`activateByTokenId`) on its
 *   markup from public/index.html, with the server's answers scripted.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const entry = (tokenId, token0, token0Symbol) => ({
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId,
  token0,
  token1: "0x" + "b2".repeat(20),
  token0Symbol,
  token1Symbol: "BBB",
  fee: 2500,
  tickLower: -100,
  tickUpper: 100,
  liquidity: "1000",
});
// Two open positions in different pools.
const FIRST = entry("101", "0x" + "a1".repeat(20), "AAA");
const SECOND = entry("102", "0x" + "a2".repeat(20), "CCC");

// The IL/G figures the first position's answer brings.
const FIRST_FIGURES = {
  pnlSnapshot: {
    totalIL: -1.5,
    lifetimeIL: -1.5,
    ilInputs: {
      lpValue: 98.5,
      price0: 1,
      price1: 1,
      residualValueUsd: 0,
      cur: { hodlAmount0: 50, hodlAmount1: 50 },
      lt: { hodlAmount0: 50, hodlAmount1: 50 },
    },
  },
};

let positions, ilDebug, store;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false }),
  });
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  document.body.innerHTML = indexHtmlDocument().body.innerHTML;
  store = await import("../public/dashboard-positions-store.js");
  positions = await import("../public/dashboard-positions.js");
  ilDebug = await import("../public/dashboard-il-debug.js");
  store.posStore.add(FIRST);
  store.posStore.add(SECOND);
});

beforeEach(() => {
  // Each case starts on the first position, its figures in, nothing open.
  positions.activateByTokenId(FIRST.tokenId);
  ilDebug.dismissILDebug();
  ilDebug.updateILDebugData(FIRST_FIGURES, store.posStore);
});

const popover = () => document.getElementById("9mm-il-debug-popover");

describe("the IL/G popover after a switch", () => {
  it("opens no popover for a position whose answer brought no figures", () => {
    positions.activateByTokenId(SECOND.tokenId);
    ilDebug.showILDebug("cur");
    assert.equal(popover(), null, "not the first position's figures");
  });

  it("closes, when open for the position before", () => {
    ilDebug.showILDebug("cur");
    assert.notEqual(popover(), null);
    positions.activateByTokenId(SECOND.tokenId);
    assert.equal(popover(), null);
  });

  it("keeps the figures of the position chosen again", () => {
    positions.activateByTokenId(FIRST.tokenId);
    ilDebug.showILDebug("cur");
    assert.notEqual(popover(), null);
  });
});
