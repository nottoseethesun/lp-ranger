"use strict";

/**
 * @file test/dashboard-manage-check.test.js
 * @description The question the dashboard asks the server each time it
 *   puts a position on screen: is this position managed?
 *
 *   Right after a switch, the last status poll still describes the
 *   position that was on screen before, so the Manage/Stop button cannot
 *   be drawn from it. `checkManagedOnSwitch` asks `GET /api/is-position-managed` instead,
 *   the button stays disabled until the answer arrives, and the answer
 *   decides between Manage and Stop. A click on the button decides from
 *   the same answer. These cases drive the real modules and the real
 *   button paint, with the server scripted.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");

const W = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const CHECKING = "Asking the server whether this position is managed…";

let check;
let ui;
let store;
let positions;
let events;

/** Answers the scripted server holds back, by request url. */
const held = new Map();
/** Every url the scripted server was asked. */
const asked = [];
/** Every request, with its method. */
const calls = [];

/** A deferred answer to the managed question for `url`. */
function holdAnswer(url) {
  let resolve;
  let reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  held.set(url, p);
  return { resolve, reject };
}

const urlFor = (id) =>
  "/api/is-position-managed?key=" +
  encodeURIComponent(`pulsechain-${W}-${PM}-${id}`);

const answer = (managed) => ({
  ok: true,
  status: 200,
  json: async () => ({ managed }),
});

const nft = (id) => ({
  positionType: "nft",
  walletAddress: W,
  contractAddress: PM,
  tokenId: String(id),
  liquidity: "1000",
});

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async (url, init) => {
    asked.push(url);
    calls.push({ url, method: init?.method ?? "GET" });
    if (held.has(url)) return held.get(url);
    if (url === "/api/wallet/status")
      return { ok: true, json: async () => ({ locked: false, address: W }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await learnActiveChain();
  const wallet = await import("../src/client/web/dashboard-wallet.js");
  await wallet.checkWalletLocked();
  store = await import("../src/client/web/dashboard-positions-store.js");
  ui = await import("../src/client/web/dashboard-manage-ui.js");
  check = await import("../src/client/web/dashboard-manage-check.js");
  positions = await import("../src/client/web/dashboard-positions.js");
  events = await import("../src/client/web/dashboard-events-manage.js");
  ui.injectManageUIDeps({
    posStore: store.posStore,
    /*-
     *  The last poll, read for the position on screen before the switch:
     *  a managed one. Nothing below may draw the button from it.
     */
    getLastStatus: () => ({ status: "running" }),
    isSyncComplete: () => true,
  });
});

beforeEach(() => {
  document.body.innerHTML =
    '<button id="manageToggleBtn"></button>' +
    '<span id="manageBadge"></span>' +
    '<button id="poolDetailsBtn"></button>';
  held.clear();
  asked.length = 0;
  calls.length = 0;
  store.updateManagedPositions([], {});
  store.posStore.entries.length = 0;
  store.posStore.activeIdx = -1;
});

/** Make `entry` the position on screen, in the real position store. */
function show(entry) {
  store.posStore.entries.push(entry);
  store.posStore.activeIdx = store.posStore.entries.length - 1;
}

/** Put `entry` on screen the way `_activateCore` does. */
function switchTo(entry) {
  show(entry);
  const done = check.checkManagedOnSwitch(entry);
  ui.paintManageUI();
  return done;
}

/** Let answered promises run their continuations. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const button = () => document.getElementById("manageToggleBtn");

describe("checkManagedOnSwitch", () => {
  it("keeps the button disabled until the server answers, then draws its answer", async () => {
    /*-
     *  The browser's managed set still says #7 is managed, as a copy
     *  restored at load or a poll from before a Stop would. The server
     *  says it is not, and its answer is what the button offers.
     */
    store.setPositionManaged("7", true);
    const server = holdAnswer(urlFor(7));
    const done = switchTo(nft(7));
    assert.equal(button().disabled, true);
    assert.equal(button().title, CHECKING);
    server.resolve(answer(false));
    await done;
    assert.equal(button().textContent, "Manage");
    assert.equal(button().disabled, false);
    assert.equal(store.isPositionManaged("7"), false);
    assert.ok(asked.includes(urlFor(7)), "asked about the position's own key");
  });

  it("offers Stop for a position the server says is managed", async () => {
    const server = holdAnswer(urlFor(8));
    const done = switchTo(nft(8));
    assert.equal(button().disabled, true);
    server.resolve(answer(true));
    await done;
    assert.equal(button().textContent, "Stop Managing");
    assert.equal(button().disabled, false);
  });

  it("leaves a newer question standing when an older answer arrives", async () => {
    const first = holdAnswer(urlFor(7));
    const firstDone = switchTo(nft(7));
    const second = holdAnswer(urlFor(8));
    const secondDone = switchTo(nft(8));
    first.resolve(answer(false));
    await firstDone;
    assert.equal(button().disabled, true, "#8 is still unanswered");
    assert.equal(button().title, CHECKING);
    second.resolve(answer(true));
    await secondDone;
    assert.equal(button().textContent, "Stop Managing");
    assert.equal(button().disabled, false);
  });

  it("goes back to the managed set when the question gets no answer", async () => {
    /*-
     *  Once with the set saying managed and once saying not, so a button
     *  that assumed either answer fails one of them.
     */
    for (const managed of [true, false]) {
      store.setPositionManaged("9", managed);
      const server = holdAnswer(urlFor(9));
      const done = switchTo(nft(9));
      server.reject(new Error("socket hang up"));
      await done;
      assert.equal(button().textContent, managed ? "Stop Managing" : "Manage");
      assert.equal(button().disabled, false);
    }
  });

  it("asks nothing about a position that is not an NFT", async () => {
    await switchTo({ ...nft(10), positionType: "erc20" });
    assert.equal(
      asked.some((u) => u.startsWith("/api/is-position-managed")),
      false,
    );
  });
});

describe("switching positions", () => {
  it("asks on every switch, through the dashboard's one switch path", async () => {
    /*-
     *  `activateByTokenId` is how a deep link, a pick in the position
     *  browser and a bot sync all put a position on screen: they share
     *  `_activateCore`, which is where the question is asked.
     */
    store.posStore.entries.push(nft(12));
    const server = holdAnswer(urlFor(12));
    assert.equal(positions.activateByTokenId("12"), true);
    assert.ok(asked.includes(urlFor(12)), "asked about the new position");
    assert.equal(button().disabled, true);
    assert.equal(button().title, CHECKING);
    server.resolve(answer(true));
    await settle();
    assert.equal(button().textContent, "Stop Managing");
    assert.equal(button().disabled, false);
  });
});

describe("the Manage/Stop click", () => {
  it("decides from the managed set, not from the badge on the page", async () => {
    /*-
     *  The badge says managed, as the position on screen before drew it;
     *  the server's answer for this one is that it is not. The click must
     *  start managing it, not send Stop.
     */
    events.injectPosStoreForEvents(store.posStore);
    show(nft(11));
    document.getElementById("manageBadge").classList.add("managed");
    await events._toggleManagePosition();
    const sent = calls.filter((c) => c.url === "/api/position/manage");
    assert.deepEqual(
      sent.map((c) => c.method),
      ["POST"],
    );
  });
});
