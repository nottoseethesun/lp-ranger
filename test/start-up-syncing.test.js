"use strict";

/**
 * @file test/start-up-syncing.test.js
 * @description The dashboard's Syncing badge while the server starts the
 *   positions saved as managed, one at a time after a launch.
 *
 *   The server reports the start-up's progress in its status answer
 *   (`startingManagedPositions`, src/handle-api-status.js), and while it
 *   does, the badge reads Syncing whatever position is on screen, naming
 *   the progress in its tooltip; the Syncing state is what keeps Manage
 *   and Stop Managing disabled. Once the start-up ends, the badge follows
 *   the position on screen again.
 *
 *   Driven end to end: the real status handler builds the answer, and the
 *   page's own poll shows it on its markup from public/index.html.
 */

require("global-jsdom/register");

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");
const config = require("../src/config");
const appPhase = require("../src/app-phase");
const { createApiStatusHandler } = require("../src/handle-api-status");
const { managedKeys } = require("../src/bot-config-v2");
const { primaryRouteLabel } = require("../src/rebalancer-swap");
const { moralisEnabledIn } = require("../src/server-moralis");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN_ID = "101";
const KEY = `pulsechain-${WALLET}-${PM}-${TOKEN_ID}`;

/*-
 *  The real status handler, for one managed position whose loop is up
 *  and whose scans are done: with no start-up under way, its badge
 *  reads Synced.
 */
const statusHandler = createApiStatusHandler({
  config,
  diskConfig: { global: {}, positions: { [KEY]: { status: "running" } } },
  positionMgr: {
    runningCount: () => 1,
    getAll: () => [{ key: KEY, tokenId: TOKEN_ID, status: "running" }],
    getPoolDailyCounts: () => ({}),
  },
  walletManager: { getAddress: () => WALLET },
  routeHandlers: { getPositionScanStatus: () => null },
  buildStatusPositions: () => ({
    [KEY]: {
      status: "running",
      running: true,
      rebalanceScanComplete: true,
      lifetimeScanComplete: true,
    },
  }),
  buildGasStatusPayload: async () => ({}),
  actualGasCostUsd: async () => 0,
  getLpProviderDisplayName: () => "9mm v3",
  managedKeys,
  primaryRouteLabel,
  moralisEnabledIn,
  jsonResponse: (res, _status, body) => {
    res.body = body;
  },
});

/** The handler's answer now. */
async function statusBody() {
  const res = {};
  await statusHandler({}, res);
  return res.body;
}

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

let poll, data;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server, from the real status handler, for the whole file, so it
   *  stays in place: the file runs in a process of its own.
   */
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return answer(await statusBody());
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
  data = await import("../public/dashboard-data.js");
  poll = await import("../public/dashboard-data-poll.js");
  const { wallet } = await import("../public/dashboard-wallet.js");
  wallet.address = WALLET;
  store.posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: TOKEN_ID,
    token0: "0x" + "a1".repeat(20),
    token1: "0x" + "b2".repeat(20),
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 2500,
    tickLower: -100,
    tickUpper: 100,
    liquidity: "1000",
  });
  store.posStore.select(0);
});

afterEach(() => appPhase._resetAppPhaseForTests());

/** One status poll, answered and shown. */
async function polled() {
  poll.pollNow();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const badge = () => document.getElementById("syncBadge");

describe("while the server starts the saved positions", () => {
  it("reads Syncing, naming the progress, though the position on screen is synced", async () => {
    appPhase.beginStartUp(3);
    appPhase.noteStartUpProgress(1);
    await polled();
    assert.equal(badge().textContent, "Syncing…");
    assert.equal(badge().title, "Starting the managed positions: 1 of 3");
    assert.equal(data.isSyncComplete(), false);
  });

  it("follows the position on screen again once the start-up ends", async () => {
    appPhase.beginStartUp(3);
    await polled();
    assert.equal(data.isSyncComplete(), false);
    appPhase.endStartUp();
    await polled();
    assert.equal(badge().textContent, "Synced");
    assert.equal(data.isSyncComplete(), true);
  });
});
