"use strict";

/**
 * @file test/dashboard-activity-figures-scan-end.test.js
 * @description When the Activity Log draws a position's entries again
 *   from the records a scan left: as the last step of a scan of the
 *   position on screen, on the status answer that first says the scan has
 *   finished, and on no answer before it (public/dashboard-data.js,
 *   `_onScanFinished`).
 *
 *   Re-scan Prices is the case. It marks the position's lifetime scan
 *   unfinished (src/server-rescan-prices.js), and the scan rebuilds the
 *   compound list, working out from the chain the figures of each
 *   compound that had none, and writing each amount at today's prices,
 *   before it marks itself finished. So for a while the status answers
 *   carry the rebuilt records while the scan still runs.
 *
 *   Driven through the page's own switch (`activateByTokenId`) and poll
 *   (`pollNow`), on its markup from public/index.html, with the server's
 *   status answers scripted.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN_ID = "101";
const KEY = `pulsechain-${WALLET}-${PM}-${TOKEN_ID}`;

/*-
 *  A compound the bot recorded before the figures existed, with the
 *  prices of its own time, so its amount is marked historical.
 */
const OLD_COMPOUND = {
  timestamp: "2026-10-21T10:51:00.000Z",
  txHash: "0x" + "cd".repeat(32),
  tokenId: TOKEN_ID,
  usdValue: 4.33,
  price0: 0.002,
  price1: 0.003,
  trigger: "auto",
};

/*-
 *  The same compound once a rebuild has written it again: its figures
 *  worked out, its amount at the prices of the rebuild, no prices of its
 *  own time.
 */
const REBUILT_COMPOUND = {
  timestamp: OLD_COMPOUND.timestamp,
  txHash: OLD_COMPOUND.txHash,
  tokenId: TOKEN_ID,
  usdValue: 3.9,
  trigger: "auto",
  feesCollected: { amount0: 10, amount1: 20 },
  historical: { percentGainForPosition: 12.5 },
};

/** The scripted server: what the position's state holds at the moment. */
const server = { lifetimeScanComplete: true, compound: OLD_COMPOUND };

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

/** The scripted status answer: one managed position, running. */
function statusAnswer() {
  return {
    global: {
      walletAddress: WALLET,
      managedPositions: [{ tokenId: TOKEN_ID, status: "running" }],
    },
    positions: {
      [KEY]: {
        status: "running",
        running: true,
        // The server gives every managed position its pool's key.
        poolKey: "pulsechain-pool-of-101",
        rebalanceScanComplete: true,
        lifetimeScanComplete: server.lifetimeScanComplete,
        compoundHistory: [server.compound],
      },
    },
  };
}

let poll;

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One status poll, answered. */
async function polled() {
  poll.pollNow();
  await settled();
}

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return answer(statusAnswer());
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url.startsWith("/api/is-position-managed"))
      return answer({ managed: true });
    return answer({ ok: false });
  };
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  const store = await import("../public/dashboard-positions-store.js");
  const data = await import("../public/dashboard-data.js");
  poll = await import("../public/dashboard-data-poll.js");
  const positions = await import("../public/dashboard-positions.js");
  const unmanaged = await import("../public/dashboard-unmanaged.js");
  const closed = await import("../public/dashboard-closed-pos.js");
  const walletModule = await import("../public/dashboard-wallet.js");
  await walletModule.checkWalletLocked();
  walletModule.wallet.address = WALLET;
  positions.injectPositionDeps({
    fetchUnmanagedDetails: unmanaged.fetchUnmanagedDetails,
    enterClosedPosView: closed.enterClosedPosView,
    exitClosedPosView: closed.exitClosedPosView,
    isViewingClosedPos: closed.isViewingClosedPos,
    resetHistoryFlag: data.resetHistoryFlag,
    pollNow: poll.pollNow,
  });
  store.posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: TOKEN_ID,
    token0: "0x" + "a1".repeat(20),
    token1: "0x" + "a2".repeat(20),
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 2500,
    tickLower: -100,
    tickUpper: 100,
    liquidity: "1000",
  });
  positions.activateByTokenId(TOKEN_ID);
  await settled();
});

/**
 * The log's one Rebalance or Compound entry: what its line reads, and its
 * figures section, line by line. Every other kind of entry keeps its
 * figures section hidden.
 */
function compoundEntry() {
  const entries = [...document.querySelectorAll("#actList .ai")].filter(
    (el) => el.querySelector('[data-tpl="fin"]')?.hidden === false,
  );
  assert.equal(entries.length, 1, "one entry with a figures section");
  const main = entries[0].querySelector('[data-tpl="main"]');
  const fin = entries[0].querySelector('[data-tpl="fin"]');
  return {
    line: main.firstChild.textContent,
    figures: [...fin.children].map((line) => line.textContent),
  };
}

const OLD_ENTRY = {
  line: "NFT #101 — $usd 4.33 (historical $usd) reinvested (Auto)",
  figures: ["Percent Gain for Position:", "Old Log: Unavailable"],
};

describe("a position's entries, once a scan of it has finished", () => {
  it("are drawn again from the records Re-scan Prices left", async () => {
    assert.deepEqual(compoundEntry(), OLD_ENTRY, "drawn as recorded");
    // Re-scan Prices: the rebuild has written the record; the scan runs on.
    server.lifetimeScanComplete = false;
    server.compound = REBUILT_COMPOUND;
    await polled();
    await polled();
    assert.deepEqual(compoundEntry(), OLD_ENTRY, "kept while the scan runs");
    server.lifetimeScanComplete = true;
    await polled();
    assert.deepEqual(compoundEntry(), {
      line: "NFT #101 — $usd 3.90 reinvested (Auto)",
      figures: [
        "Percent Gain for Position:",
        "Current: — · Historical: 12.500%",
      ],
    });
  });
});
