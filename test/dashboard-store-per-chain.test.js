"use strict";

/**
 * @file test/dashboard-store-per-chain.test.js
 * @description The browser keeps its copies of what the server scanned
 *   per chain.
 *
 *   The position list, the set of managed positions and the last position
 *   viewed are held in localStorage so the page can draw them before the
 *   first poll lands. The server runs one chain for its life, but it can
 *   be restarted on another at the same address, and the browser's copies
 *   outlive it. Each key therefore ends with the active chain, and a copy
 *   saved under another chain is never read.
 *
 *   The page's buttons work before startup has learned the chain, so a
 *   change to the store can come first. Until the chain is known nothing
 *   is read or written: a key built from the unknown chain would end in
 *   `_null` and stay in the browser for good.
 *
 *   Runs the real store under jsdom, with the chain learned through the
 *   real `loadActiveChain` from a scripted server. The cases that need no
 *   chain come first, since a chain once learned is kept.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let store;
let chain;
let storage;

before(async () => {
  chain = await import("../public/dashboard-chain.js");
  store = await import("../public/dashboard-positions-store.js");
  storage = await import("../public/dashboard-chain-storage.js");
});

beforeEach(() => {
  localStorage.clear();
  store.posStore.entries.length = 0;
  store.posStore.activeIdx = -1;
});

const ENTRY = {
  tokenId: "158981",
  walletAddress: "0x1111111111111111111111111111111111111111",
  positionType: "nft",
  active: true,
};

describe("before the server names the chain", () => {
  it("writes none of the copies", () => {
    assert.equal(chain.activeChainId(), null);
    assert.equal(store.posStore.add({ ...ENTRY }).ok, true);
    store.posStore.select(0);
    store.posStore.updateActiveTokenId("159013");
    store.updateManagedPositions([{ tokenId: "7", status: "running" }], {});
    assert.equal(localStorage.length, 0, "no key was written");
  });

  it("reads none of them", () => {
    localStorage.setItem(
      "9mm_position_store_null",
      JSON.stringify({ entries: [ENTRY], activeIdx: 0 }),
    );
    localStorage.setItem("9mm_last_position_null", "158981");
    store._loadPosStore();
    assert.equal(store.posStore.entries.length, 0);
    assert.equal(storage.readLastPosition(), null);
  });
});

describe("the browser's per-chain copies", () => {
  before(async () => {
    await chain.loadActiveChain({
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ chainId: "pulsechain" }),
      }),
      onUnanswered: () => {},
      onAnswered: () => {},
    });
  });

  it("save the position list and the last position under the active chain", () => {
    store.posStore.entries.push({ ...ENTRY, index: 0 });
    store.posStore.activeIdx = 0;
    store.posStore.updateActiveTokenId("159013");
    assert.ok(localStorage.getItem("9mm_position_store_pulsechain"));
    assert.equal(
      localStorage.getItem("9mm_last_position_pulsechain"),
      "159013",
    );
    assert.equal(localStorage.getItem("9mm_position_store"), null);
    assert.equal(localStorage.getItem("9mm_last_position"), null);
  });

  it("never load a position list saved under another chain", () => {
    localStorage.setItem(
      "9mm_position_store_pulsechain-testnet",
      JSON.stringify({ entries: [ENTRY], activeIdx: 0 }),
    );
    store._loadPosStore();
    assert.equal(store.posStore.entries.length, 0);
  });

  it("load the active chain's own list", () => {
    localStorage.setItem(
      "9mm_position_store_pulsechain",
      JSON.stringify({ entries: [ENTRY], activeIdx: 0 }),
    );
    store._loadPosStore();
    assert.equal(store.posStore.entries.length, 1);
    assert.equal(store.posStore.entries[0].tokenId, "158981");
  });

  it("keep the managed set per chain, and restore only the active chain's", () => {
    store.updateManagedPositions([{ tokenId: "7", status: "running" }], {});
    assert.equal(
      localStorage.getItem("9mm_managed_token_ids_pulsechain"),
      JSON.stringify(["7"]),
    );
    localStorage.setItem(
      "9mm_managed_token_ids_pulsechain-testnet",
      JSON.stringify(["99"]),
    );
    store.restoreManagedPositions();
    assert.equal(store.isPositionManaged("7"), true);
    assert.equal(store.isPositionManaged("99"), false);
  });
});
