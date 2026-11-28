"use strict";

/**
 * @file test/bot-wallet-change-refusal.test.js
 * @description The bot's own refusals of a Clear and a wallet import
 *   (src/bot/bot-interface.js `refusalToChangeWallet`, `refusalToImport`),
 *   built over its positions' states and the positions whose start is
 *   under way (src/bot/position-manager.js `startingKeys`), as the
 *   server asks them. Both are refused while a rebalance or compound is
 *   under way or a position is starting, naming it (the user's design,
 *   2026-11-27: refuse, never wait). The test helpers that build the
 *   Clear route and the status answer rebuild the same rule over
 *   stand-ins; this drives the interface's own binding, so a binding
 *   that dropped the states or the starts would fail here. A Rebalance
 *   Now or Compound Now is refused while an import holds every move,
 *   since a position marked then and halted by the import would refuse
 *   every later Clear and import until a restart.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { botOperations } = require("../src/bot/bot-interface");
const appPhase = require("../src/bot/app-phase");

const KEY = "pulsechain-0xW-0xPM-157149";
const POSITION = {
  activePosition: {
    tokenId: "157149",
    token0Symbol: "WPLS",
    token1Symbol: "DAI",
  },
};

/**
 * The bot's operations over `states` (each position's bot state, by key)
 * and `starting` (the keys whose start is under way).
 */
function bot({ states = new Map(), starting = [] } = {}) {
  return botOperations({
    diskConfig: { global: {}, positions: {} },
    walletManager: { getAddress: () => "0xW" },
    positionMgr: { startingKeys: () => starting },
    privateKeyRef: { current: null },
    getAllPositionBotStates: () => states,
  });
}

describe("the bot's refusal of a Clear and an import", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("is none while nothing is under way", () => {
    const b = bot({ states: new Map([[KEY, POSITION]]) });
    assert.equal(b.refusalToChangeWallet("Clear Wallet"), null);
    assert.equal(b.refusalToImport(), null);
  });

  it("names a rebalance under way", () => {
    const b = bot({
      states: new Map([[KEY, { ...POSITION, rebalanceInProgress: true }]]),
    });
    assert.equal(
      b.refusalToChangeWallet("Clear Wallet"),
      "LP Ranger is rebalancing WPLS/DAI NFT #157149. Try Clear Wallet again once it has finished.",
    );
    assert.equal(
      b.refusalToImport(),
      "LP Ranger is rebalancing WPLS/DAI NFT #157149. Try the import again once it has finished.",
    );
  });

  it("names a compound under way", () => {
    const b = bot({
      states: new Map([[KEY, { ...POSITION, compoundInProgress: true }]]),
    });
    assert.match(
      b.refusalToChangeWallet("Clear Wallet"),
      /^LP Ranger is compounding WPLS\/DAI NFT #157149\./,
    );
  });

  it("names a position whose start is under way", () => {
    const b = bot({ states: new Map([[KEY, POSITION]]), starting: [KEY] });
    assert.equal(
      b.refusalToChangeWallet("Clear Wallet"),
      "LP Ranger is starting WPLS/DAI NFT #157149. Try Clear Wallet again once it has started.",
    );
    assert.match(b.refusalToImport(), /^LP Ranger is starting WPLS/);
  });

  it("refuses an import first for what refuses any start", () => {
    // A stop, a start-up or another import under way comes before a move.
    appPhase.markStopping();
    const b = bot({
      states: new Map([[KEY, { ...POSITION, rebalanceInProgress: true }]]),
    });
    assert.equal(
      b.refusalToImport(),
      "LP Ranger is stopping, so nothing starts.",
    );
  });
});

describe("a Rebalance Now or Compound Now while a wallet import holds every move", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("is refused, so the import's halt leaves no position marked and the next Clear goes through", () => {
    /*-
     *  Taken, the request would mark the position as rebalancing, and
     *  the import would halt it before its next check took the mark off:
     *  every later Clear and import would be refused until a restart.
     */
    const state = { ...POSITION, running: true };
    const b = bot({ states: new Map([[KEY, state]]) });
    assert.equal(b.beginWalletImport(), null, "the import begins");
    const rebalance = b.requestRebalance(KEY);
    assert.equal(rebalance.ok, false);
    assert.equal(rebalance.reason, "refused");
    assert.equal(
      rebalance.error,
      "LP Ranger is importing a wallet, so no rebalance or compound starts now. Try Rebalance Now again once the import has finished.",
    );
    const compound = b.requestCompound(KEY);
    assert.equal(compound.ok, false);
    assert.match(compound.error, /Try Compound Now again once the import/);
    assert.equal(state.rebalanceInProgress, undefined, "not marked");
    assert.equal(state.forceRebalance, undefined);
    assert.equal(state.forceCompound, undefined);
    b.endWalletImport();
    assert.equal(b.refusalToChangeWallet("Clear Wallet"), null);
  });

  it("is taken again once the import has ended", () => {
    const state = { ...POSITION, running: true };
    const b = bot({ states: new Map([[KEY, state]]) });
    b.beginWalletImport();
    b.endWalletImport();
    assert.equal(b.requestRebalance(KEY).ok, true);
    assert.equal(state.rebalanceInProgress, true);
  });
});
