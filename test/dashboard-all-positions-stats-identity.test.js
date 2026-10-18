"use strict";

/**
 * @file test/dashboard-all-positions-stats-identity.test.js
 * @description Each All Positions Stats row names its position from the
 *   position's own key: the chain, the wallet and the position manager,
 *   and so its LP provider and the link to it.
 *
 *   The status answer also carries addresses outside any position's
 *   key, and on an install upgraded from an older release those can be
 *   addresses that release saved, no longer the ones in use. The row
 *   reads none of them, so they change nothing it shows. Driven through
 *   the open modal on its own markup from public/index.html.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const FACTORY = "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const WALLET = "0x1111111111111111111111111111111111111111";
const KEY = `pulsechain-${WALLET}-${PM}-12345`;

/** Addresses an older release saved, spread into the status answer. */
const STALE = {
  positionManager: "0x2222222222222222222222222222222222222222",
  factory: "0x3333333333333333333333333333333333333333",
  walletAddress: "0x4444444444444444444444444444444444444444",
};

/** A flattened status answer holding one open, managed position. */
const data = {
  ...STALE,
  chainDisplayName: "PulseChain",
  chainId: "pulsechain",
  _allPositionStates: {
    [KEY]: {
      status: "running",
      activePosition: {
        tokenId: "12345",
        liquidity: "1000",
        token0: "0x5555555555555555555555555555555555555555",
        token1: "0x6666666666666666666666666666666666666666",
        token0Symbol: "AAA",
        token1Symbol: "BBB",
        fee: 10000,
      },
      pnlSnapshot: { currentValue: 100, totalLifetimeDeposit: 90 },
    },
  },
};

let stats;

before(async () => {
  globalThis.fetch = async (url) => {
    if (url === "/api/lp-providers")
      return {
        ok: true,
        json: async () => ({
          [`${FACTORY}_${PM}`]: {
            displayName: "9mm v3",
            supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
          },
        }),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await learnActiveChain("pulsechain");
  const providers = await import("../public/dashboard-lp-providers.js");
  await providers.loadLpProviders();
  stats = await import("../public/dashboard-all-positions-stats.js");
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("allPositionsStatsModal"), true),
  );
  stats.openAllPositionsStatsModal();
  stats.updateAllPositionsStatsBtn(data);
});

/*-
 *  By class name, not selector: a class that starts with a digit is not
 *  a valid CSS selector unless escaped.
 */
const first = (cls) => document.getElementsByClassName(cls)[0];

describe("an All Positions Stats row", () => {
  it("links to its position by its own key, addresses checksummed", () => {
    const link = first("9mm-pos-mgr-all-positions-goto");
    assert.ok(link, "the row is drawn");
    assert.equal(
      link.getAttribute("href"),
      `/pulsechain/${WALLET}/${PM}/12345`,
    );
  });

  it("names the provider of its own position manager", () => {
    const meta = first("9mm-pos-mgr-all-positions-meta");
    assert.match(meta.textContent, /9mm v3/);
  });
});
