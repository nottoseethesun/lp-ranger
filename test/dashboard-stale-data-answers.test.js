"use strict";

/**
 * @file test/dashboard-stale-data-answers.test.js
 * @description Which answer makes the figures on screen fresh after a
 *   switch, and what is asked again until one comes.
 *
 *   An open managed position's figures come from the status poll, an
 *   unmanaged one's from its details request, a closed one's from its
 *   history request (src/client/web/dashboard-stale-data.js). An answer counts
 *   only for the position it was about, an error answer counts, and with
 *   no answer the figures stay stale while each status answer asks again.
 *   A switch also empties the Bot Settings boxes holding the position's
 *   settings, which the new position's answer fills.
 *
 *   Driven through the page's own switch (`activateByTokenId`) and poll
 *   (`pollNow`), on its markup from src/client/web/index.html, with the server's
 *   answers scripted.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const keyOf = (tokenId) => `pulsechain-${WALLET}-${PM}-${tokenId}`;
const entry = (tokenId, liquidity) => ({
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId,
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "a2".repeat(20),
  token0Symbol: "AAA",
  token1Symbol: "BBB",
  fee: 2500,
  tickLower: -100,
  tickUpper: 100,
  liquidity,
});
// Two open managed positions, two open unmanaged, one closed.
const MANAGED = entry("101", "1000");
const MANAGED_TOO = entry("102", "1000");
const UNMANAGED = entry("201", "1000");
const UNMANAGED_TOO = entry("202", "1000");
const CLOSED = entry("301", "0");

/*-
 *  The scripted server. `details` and `history` answer as each test sets
 *  them, and every request is counted, so a test can tell what was asked.
 */
const server = {
  managed: new Set(["101", "102"]),
  minIntervalMin: 7,
  details: null,
  history: null,
  asked: [],
};

const answer = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

/** A details answer the page can show: an in-range position with value. */
const DETAILS = {
  ok: true,
  poolState: { price: 1, tick: 0 },
  lowerPrice: 0.99,
  upperPrice: 1.01,
  amounts: { amount0: 1, amount1: 1 },
  value: 2,
  price0: 1,
  price1: 1,
  feesUsd: 0,
};

/** The scripted status answer: the managed positions, each with its data. */
function statusAnswer() {
  const positions = {};
  for (const t of server.managed)
    positions[keyOf(t)] = {
      status: "running",
      minRebalanceIntervalMin: server.minIntervalMin,
      maxRebalancesPerDay: 5,
    };
  return {
    global: {
      walletAddress: WALLET,
      managedPositions: [...server.managed].map((t) => ({
        tokenId: t,
        status: "running",
      })),
      approvalMultiple: 20,
    },
    positions,
  };
}

let store, stale, positions, poll, data, wallet;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares. Two cases below
   *  hold or refuse answers for a while, each putting this back.
   */
  globalThis.fetch = async (url) => {
    server.asked.push(url);
    if (url === "/api/status") return answer(statusAnswer());
    if (url === "/api/position/details") return server.details();
    if (/^\/api\/position\/\d+\/history$/.test(url)) return server.history();
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url.startsWith("/api/is-position-managed"))
      return answer({ managed: server.managed.has(url.split("-").pop()) });
    return answer({ ok: false });
  };
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  store = await import("../src/client/web/dashboard-positions-store.js");
  stale = await import("../src/client/web/dashboard-stale-data.js");
  data = await import("../src/client/web/dashboard-data.js");
  poll = await import("../src/client/web/dashboard-data-poll.js");
  positions = await import("../src/client/web/dashboard-positions.js");
  const unmanaged = await import("../src/client/web/dashboard-unmanaged.js");
  const closed = await import("../src/client/web/dashboard-closed-pos.js");
  ({ wallet } = await import("../src/client/web/dashboard-wallet.js"));
  const walletModule = await import("../src/client/web/dashboard-wallet.js");
  await walletModule.checkWalletLocked();
  wallet.address = WALLET;
  positions.injectPositionDeps({
    fetchUnmanagedDetails: unmanaged.fetchUnmanagedDetails,
    enterClosedPosView: closed.enterClosedPosView,
    exitClosedPosView: closed.exitClosedPosView,
    isViewingClosedPos: closed.isViewingClosedPos,
    resetHistoryFlag: data.resetHistoryFlag,
    pollNow: poll.pollNow,
  });
  for (const p of [MANAGED, MANAGED_TOO, UNMANAGED, UNMANAGED_TOO, CLOSED])
    store.posStore.add(p);
});

beforeEach(() => {
  server.details = async () => answer(DETAILS);
  server.history = async () => answer({ exitValueUsd: 10, entryValueUsd: 9 });
  server.asked.length = 0;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Switch to a position, as the position browser does, and let it settle. */
async function switchTo(p) {
  positions.activateByTokenId(p.tokenId);
  await settled();
}

/** One status poll, answered. */
async function polled() {
  poll.pollNow();
  await settled();
}

const asked = (url) => server.asked.filter((u) => u === url).length;

/**
 * Hold every status answer back, as a slow server would, until the
 * returned function lets them through and they have been shown.
 * @returns {() => Promise<void>}
 */
function holdStatus() {
  const real = globalThis.fetch;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") await held;
    return real(url, init);
  };
  return async () => {
    globalThis.fetch = real;
    release();
    await settled();
  };
}

describe("an open managed position", () => {
  it("is stale from the switch until a status answer carries its data", async () => {
    // The page learns which positions are managed, as its first poll does.
    await polled();
    positions.activateByTokenId(MANAGED.tokenId);
    assert.equal(stale.isPositionDataStale(), true);
    await settled();
    assert.equal(stale.isPositionDataStale(), false);
    assert.equal(asked("/api/position/details"), 0, "no details asked");
  });

  it("stays stale while the server does not answer the status poll", async () => {
    await switchTo(MANAGED_TOO);
    const real = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      positions.activateByTokenId(MANAGED.tokenId);
      await settled();
      await polled();
      assert.equal(stale.isPositionDataStale(), true);
    } finally {
      globalThis.fetch = real;
    }
    await polled();
    assert.equal(stale.isPositionDataStale(), false);
  });
});

describe("an open unmanaged position", () => {
  it("is not made fresh by a status answer, but by its details", async () => {
    let release;
    server.details = () =>
      new Promise((resolve) => {
        release = () => resolve(answer(DETAILS));
      });
    await switchTo(UNMANAGED);
    await polled();
    assert.equal(stale.isPositionDataStale(), true, "details not in yet");
    release();
    await settled();
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is made fresh by an error answer, whose figures stay dashes", async () => {
    server.details = async () => answer({ ok: false, error: "rpc down" });
    await switchTo(UNMANAGED_TOO);
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is asked about again by the next status answer, not before", async () => {
    // Refused a moment later, as a server that is down refuses.
    server.details = () =>
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("connection refused")), 0),
      );
    await switchTo(UNMANAGED);
    assert.equal(stale.isPositionDataStale(), true);
    assert.equal(asked("/api/position/details"), 1, "not asked again at once");
    server.details = async () => answer(DETAILS);
    await polled();
    assert.equal(asked("/api/position/details"), 2, "asked again");
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is not asked about twice while its details are out", async () => {
    let release;
    server.details = () =>
      new Promise((resolve) => {
        release = () => resolve(answer(DETAILS));
      });
    await switchTo(UNMANAGED_TOO);
    await polled();
    await polled();
    assert.equal(asked("/api/position/details"), 1);
    release();
    await settled();
  });

  it("is asked about when a managed list kept from before was wrong", async () => {
    // The browser thinks the position is managed; the server does not.
    store.setPositionManaged(UNMANAGED.tokenId, true);
    server.details = async () => answer(DETAILS);
    positions.activateByTokenId(UNMANAGED.tokenId);
    store.setPositionManaged(UNMANAGED.tokenId, true);
    await settled();
    await polled();
    assert.ok(asked("/api/position/details") >= 1, "the details were asked");
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("ignores details that arrive after a switch to another position", async () => {
    let release;
    server.details = () =>
      new Promise((resolve) => {
        release = () => resolve(answer(DETAILS));
      });
    await switchTo(UNMANAGED_TOO);
    // MANAGED's status answer is held back, so only the late details land.
    const letStatusThrough = holdStatus();
    positions.activateByTokenId(MANAGED.tokenId);
    release();
    await settled();
    assert.equal(stale.isPositionDataStale(), true);
    await letStatusThrough();
    assert.equal(stale.isPositionDataStale(), false);
  });
});

describe("a position put back on screen", () => {
  it("is asked about again when its details were dropped meanwhile", async () => {
    let release;
    server.details = () =>
      new Promise((resolve) => {
        release = () => resolve(answer(DETAILS));
      });
    await switchTo(UNMANAGED);
    await switchTo(MANAGED);
    // UNMANAGED's details land while MANAGED is on screen, and are dropped.
    release();
    await settled();
    server.details = async () => answer(DETAILS);
    await switchTo(UNMANAGED);
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is stale after the dashboard drops its answers, as a change of wallet does", async () => {
    await switchTo(MANAGED);
    assert.equal(stale.isPositionDataStale(), false);
    data.resetPollingState();
    assert.equal(stale.isPositionDataStale(), true);
    await polled();
  });
});

describe("a closed position", () => {
  it("is made fresh by its history answer", async () => {
    await switchTo(CLOSED);
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is not asked about twice while its history is out", async () => {
    await switchTo(MANAGED);
    let release;
    server.history = () =>
      new Promise((resolve) => {
        release = () => resolve(answer({ exitValueUsd: 10 }));
      });
    await switchTo(CLOSED);
    await polled();
    await polled();
    assert.equal(asked(`/api/position/${CLOSED.tokenId}/history`), 1);
    release();
    await settled();
  });

  it("keeps a history answer that arrives after a switch off the screen", async () => {
    await switchTo(MANAGED);
    const shown = document.getElementById("kpiValue").textContent;
    let release;
    server.history = () =>
      new Promise((resolve) => {
        release = () => resolve(answer({ exitValueUsd: 1234.5 }));
      });
    await switchTo(CLOSED);
    await switchTo(MANAGED);
    release();
    await settled();
    assert.equal(document.getElementById("kpiValue").textContent, shown);
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("stays stale with no history answer, and is asked again", async () => {
    await switchTo(MANAGED);
    server.history = async () => {
      throw new Error("connection refused");
    };
    await switchTo(CLOSED);
    assert.equal(stale.isPositionDataStale(), true);
    server.history = async () => answer({ exitValueUsd: 10 });
    await polled();
    assert.equal(stale.isPositionDataStale(), false);
  });
});

describe("the Bot Settings boxes", () => {
  const value = (id) => document.getElementById(id).value;

  it("empty at a switch and fill from the new position's answer", async () => {
    await switchTo(MANAGED);
    assert.equal(value("inMinInterval"), "7");
    server.minIntervalMin = 9;
    const letStatusThrough = holdStatus();
    positions.activateByTokenId(MANAGED_TOO.tokenId);
    await settled();
    assert.equal(value("inMinInterval"), "", "emptied at the switch");
    await letStatusThrough();
    assert.equal(value("inMinInterval"), "9");
    server.minIntervalMin = 7;
  });

  it("keep the install's Approval Multiple through a switch", async () => {
    document.getElementById("inApprovalMultiple").value = "20";
    await switchTo(UNMANAGED);
    assert.equal(value("inApprovalMultiple"), "20");
  });
});
