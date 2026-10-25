"use strict";

/**
 * @file test/dashboard-activity-log-second-data-load.test.js
 * @description A managed position reaches the page in two data loads:
 *   its saved records come first, as the server starts it, and its pair,
 *   fee tier and pool key once the server has read it from the
 *   blockchain. The Activity Log draws none of its Rebalance or Compound
 *   entries before the second (`canDrawPositionEntries`,
 *   src/client/web/dashboard-activity-figures.js), from neither the live event
 *   check nor the history pass. So each entry is drawn with its position
 *   line and filed under its pool, which is how the end of a scan finds
 *   it to draw again.
 *
 *   The server's start-up is the case: it starts the positions saved as
 *   managed one at a time, so a page open meanwhile gets a position's
 *   records some while before the rest of it. Driven through the page's
 *   own switch (`activateByTokenId`) and poll (`pollNow`), on its markup
 *   from src/client/web/index.html, with the server's status answers scripted.
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
const TOKEN0 = "0x" + "a1".repeat(20);
const TOKEN1 = "0x" + "a2".repeat(20);

/** The position's latest compound, as the bot recorded it. */
const RECORDED_COMPOUND = {
  timestamp: "2026-10-21T10:51:00.000Z",
  txHash: "0x" + "cd".repeat(32),
  tokenId: TOKEN_ID,
  usdValue: 4.33,
  price0: 0.002,
  price1: 0.003,
  trigger: "auto",
};

/*-
 *  The same compound once a scan has written its record again: its
 *  figures worked out, its amount at the prices of the scan.
 */
const REWRITTEN_COMPOUND = {
  timestamp: RECORDED_COMPOUND.timestamp,
  txHash: RECORDED_COMPOUND.txHash,
  tokenId: TOKEN_ID,
  usdValue: 3.9,
  trigger: "auto",
  feesCollected: { amount0: 10, amount1: 20 },
  historical: { percentGainForPosition: 12.5 },
};

/** The scripted server: how far it has got with the position. */
const server = {
  positionRead: false,
  scanComplete: false,
  compound: RECORDED_COMPOUND,
};

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

/**
 * The scripted status answer: one position saved as managed. Until the
 * server has read the position from the blockchain, its state holds its
 * saved records alone and its loop is not yet running, as while the
 * server is starting it.
 */
function statusAnswer() {
  const position = {
    status: "running",
    running: false,
    rebalanceScanComplete: server.scanComplete,
    lifetimeScanComplete: server.scanComplete,
    compoundHistory: [server.compound],
    lastCompoundAt: server.compound.timestamp,
  };
  if (server.positionRead)
    Object.assign(position, {
      running: true,
      walletAddress: WALLET,
      activePosition: {
        tokenId: TOKEN_ID,
        token0: TOKEN0,
        token1: TOKEN1,
        token0Symbol: "AAA",
        token1Symbol: "BBB",
        fee: 2500,
      },
      // The server gives a managed position its pool's key once read.
      poolKey: "pulsechain-pool-of-101",
    });
  return {
    global: {
      walletAddress: WALLET,
      managedPositions: [{ tokenId: TOKEN_ID, status: "running" }],
    },
    positions: { [KEY]: position },
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
  const store = await import("../src/client/web/dashboard-positions-store.js");
  const data = await import("../src/client/web/dashboard-data.js");
  poll = await import("../src/client/web/dashboard-data-poll.js");
  const positions = await import("../src/client/web/dashboard-positions.js");
  const unmanaged = await import("../src/client/web/dashboard-unmanaged.js");
  const closed = await import("../src/client/web/dashboard-closed-pos.js");
  const walletModule = await import("../src/client/web/dashboard-wallet.js");
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
    token0: TOKEN0,
    token1: TOKEN1,
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
 * The log's Rebalance and Compound entries, the only ones with a figures
 * section shown: what each one's line reads, and its position line, or
 * null for an entry drawn without one.
 */
function loggedEntries() {
  return [...document.querySelectorAll("#actList .ai")]
    .filter((el) => el.querySelector('[data-tpl="fin"]')?.hidden === false)
    .map((el) => ({
      line: el.querySelector('[data-tpl="main"]').firstChild.textContent,
      position: el.querySelector('[data-tpl="ctx"]')?.textContent ?? null,
    }));
}

describe("a managed position's entries, while the server starts it", () => {
  it("wait for its second data load", async () => {
    await polled();
    await polled();
    assert.deepEqual(loggedEntries(), [], "none from its records alone");
    server.positionRead = true;
    await polled();
    const logged = loggedEntries();
    assert.equal(logged.length, 1, "its latest compound, once");
    assert.equal(
      logged[0].line,
      "NFT #101 — $usd 4.33 (historical $usd) reinvested (Auto)",
    );
    assert.match(logged[0].position ?? "", /^AAA\/BBB\b.*· NFT #101\b/);
  });

  it("are filed under the position's pool, so a scan's end draws them again", async () => {
    // The scan that follows the start-up finishes, its record rewritten.
    server.compound = REWRITTEN_COMPOUND;
    server.scanComplete = true;
    await polled();
    assert.deepEqual(
      loggedEntries().map((entry) => entry.line),
      ["NFT #101 — $usd 3.90 reinvested (Auto)"],
    );
  });
});
