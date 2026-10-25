"use strict";

/**
 * @file test/dashboard-chain-keys.test.js
 * @description Dashboard keys are built on the chain the server names,
 *   never on an assumed one. The cases learn a chain other than
 *   PulseChain, whose name holds a dash, so a key that hard-codes
 *   `pulsechain` or reads a key's segments from the left fails here.
 *
 *   Reload Current Position and Re-scan Prices send their key to the
 *   server, which finds the position's bot state by it: a key on the
 *   wrong chain finds nothing.
 *   The per-pool storage keys hold the operator's own entries (deposit,
 *   realized gains), which belong to one chain. So do the pool gates on
 *   the Manage button, the flags that keep a poll from overwriting an
 *   input being edited, and the browser's copy of rebalance events.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { poolKey } = require("../src/lib/pool-key");

const WALLET = "0x4e44847675763d5540b32bee8a713cfdcb4be61a";
const PM = "0xcc05bf158202b4f461ede8843d76dcd7bbad07f2";
const T0 = "0x0000000000000000000000000000000000000a11";
const T1 = "0x0000000000000000000000000000000000000a12";
const EVENTS_CACHE = "9mm_rebalance_events_cache";

let reloadFlow;
let rescanPrices;
let deposit;
let manageUi;
let dataCache;
let store;

before(async () => {
  reloadFlow = await import("../src/client/web/dashboard-reload-flow.js");
  rescanPrices = await import("../src/client/web/dashboard-rescan-prices.js");
  deposit = await import("../src/client/web/dashboard-data-deposit.js");
  manageUi = await import("../src/client/web/dashboard-manage-ui.js");
  dataCache = await import("../src/client/web/dashboard-data-cache.js");
  store = await import("../src/client/web/dashboard-positions-store.js");
  /*-
   *  One NFT position, active, as the position store holds it once
   *  restored from the browser's storage at page load — which is before
   *  the server has named the chain.
   */
  store.posStore.entries.length = 0;
  store.posStore.entries.push({
    tokenId: "7",
    walletAddress: WALLET,
    contractAddress: PM,
    token0: T0,
    token1: T1,
    fee: 10000,
  });
  store.posStore.activeIdx = 0;
});

describe("dashboard keys before the chain is known", () => {
  it("are not built at all", () => {
    /*-
     *  Startup learns the chain before anything builds a key; a key
     *  built before then would have to assume one.
     */
    assert.equal(
      deposit._poolKeyFrom("9mm_deposit_pool_", WALLET, PM, T0, T1, 10000),
      null,
    );
    assert.equal(reloadFlow._buildKey(WALLET, PM, "7"), null);
    assert.equal(rescanPrices._activeKey(), null);
    assert.equal(manageUi._poolKeyOf(store.posStore.getActive()), null);
  });

  it("leave no trace of an edit or of rebalance events", () => {
    /*-
     *  Inputs answer to the keyboard from page load, before the chain is
     *  known. Neither an edit nor a cached event may be filed under a
     *  key that names no chain.
     */
    dataCache.markInputDirty("inOorTimeout");
    assert.equal(dataCache.isInputDirty("inOorTimeout"), false);
    dataCache.cacheRebalanceEvents([{ newTokenId: "7" }]);
    assert.equal(localStorage.getItem(EVENTS_CACHE), null);
  });
});

describe("dashboard keys on the chain the server names", () => {
  before(() => learnActiveChain("pulsechain-testnet"));

  it("Reload Current Position sends a key on that chain, addresses checksummed", () => {
    assert.equal(
      reloadFlow._buildKey(WALLET, PM, "7"),
      "pulsechain-testnet-0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-" +
        "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-7",
    );
  });

  it("Re-scan Prices sends the same key", () => {
    assert.equal(
      rescanPrices._activeKey(),
      reloadFlow._buildKey(WALLET, PM, "7"),
    );
  });

  it("per-pool storage keys are filed under that chain", () => {
    assert.equal(
      deposit._poolKeyFrom("9mm_deposit_pool_", WALLET, PM, T0, T1, 10000),
      `9mm_deposit_pool_pulsechain-testnet_${WALLET}_${PM}_${T0}_${T1}_10000`,
    );
  });

  it("the Manage button's pool gates key the pool on that chain", () => {
    assert.equal(
      manageUi._poolKeyOf(store.posStore.getActive()),
      poolKey("pulsechain-testnet", PM, WALLET, T0, T1, 10000),
    );
  });

  it("an edit is flagged, and rebalance events cached, under that chain", () => {
    dataCache.markInputDirty("inOorTimeout");
    assert.equal(dataCache.isInputDirty("inOorTimeout"), true);
    dataCache.clearDirtyInputs();
    dataCache.cacheRebalanceEvents([{ newTokenId: "7" }]);
    const cached = JSON.parse(localStorage.getItem(EVENTS_CACHE));
    assert.deepEqual(Object.keys(cached), [
      `pulsechain-testnet-${WALLET}-${PM}-${T0}-${T1}-10000`,
    ]);
  });
});
