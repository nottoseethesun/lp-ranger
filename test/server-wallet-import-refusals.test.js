"use strict";

/**
 * @file test/server-wallet-import-refusals.test.js
 * @description A wallet import (`POST /api/wallet`,
 *   src/server/server-routes.js) and the moves it must not land among
 *   (the user's design, 2026-11-27: refuse, never wait). It is refused at
 *   once while a rebalance or compound is under way or a position is
 *   starting (src/bot/under-way.js), naming it, and changes nothing. Once
 *   taken, it holds every rebalance and compound from its first step
 *   until the old wallet's positions are halted (src/bot/app-phase.js),
 *   so none begins while it saves the new wallet, and it lets them go
 *   again if saving fails. The rest of the import is tested in
 *   test/server-routes.test.js.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createRouteHandlers } = require("./_bot-route-adapters");
const appPhase = require("../src/bot/app-phase");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");

describe("a wallet import among the bot's moves", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("is refused at once while a rebalance is under way, naming it, and changes nothing", async () => {
    /*-
     *  Refused rather than waited for: an import that waited stopped the
     *  old positions only once the move had finished, its request
     *  hanging meanwhile.
     */
    let imported = false;
    let halted = false;
    const states = new Map([
      [
        "pulsechain-0xW-0xPM-7",
        {
          rebalanceInProgress: true,
          activePosition: { tokenId: "7" },
        },
      ],
    ]);
    const deps = makeDeps({
      getAllPositionBotStates: () => states,
      walletManager: {
        ...makeDeps().walletManager,
        importWallet: async () => {
          imported = true;
        },
      },
      positionMgr: {
        ...makeDeps().positionMgr,
        haltAll: () => {
          halted = true;
        },
      },
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleWalletImport({}, res);
    assert.equal(res._status, 409);
    assert.equal(
      res._body.error,
      "LP Ranger is rebalancing NFT #7. Try the import again once it has finished.",
    );
    assert.equal(imported, false, "nothing saved");
    assert.equal(halted, false, "nothing halted");
    assert.equal(appPhase.walletImportUnderWay(), false, "no import begun");
    assert.equal(appPhase.movesHeld(), false, "no move held");
  });

  it("is refused at once while a position is starting", async () => {
    // Its first check can rebalance before its loop can be halted.
    const deps = makeDeps({
      positionMgr: {
        ...makeDeps().positionMgr,
        startingKeys: () => ["pulsechain-0xW-0xPM-9"],
      },
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleWalletImport({}, res);
    assert.equal(res._status, 409);
    assert.equal(
      res._body.error,
      "LP Ranger is starting NFT #9. Try the import again once it has started.",
    );
  });

  it("holds every move from its first step until the old positions are halted", async () => {
    /*-
     *  Saving the new wallet takes a moment, in which a check could
     *  otherwise begin a rebalance the halt would not stop.
     */
    const seen = {};
    const deps = makeDeps({
      readJsonBody: async () => ({ address: "0x2", password: "pw" }),
      walletManager: {
        ...makeDeps().walletManager,
        importWallet: async () => {
          seen.whileSaving = appPhase.movesHeld();
        },
      },
      positionMgr: {
        ...makeDeps().positionMgr,
        haltAll: () => {
          seen.atHalt = appPhase.movesHeld();
        },
        resetSharedSigner: () => {},
      },
      updatePositionState: () => {},
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleWalletImport({}, res);
    assert.equal(res._status, 200);
    assert.equal(seen.whileSaving, true, "held while it saves");
    assert.equal(seen.atHalt, true, "held until the halt");
    assert.equal(appPhase.movesHeld(), false, "released once halted");
  });

  it("releases the moves it held when saving the new wallet fails", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ address: "0x2", password: "pw" }),
      walletManager: {
        ...makeDeps().walletManager,
        importWallet: async () => {
          throw new Error("disk full");
        },
      },
    });
    await assert.rejects(
      createRouteHandlers(deps)._handleWalletImport({}, makeRes()),
      /disk full/,
    );
    assert.equal(appPhase.movesHeld(), false, "moves may begin again");
    assert.equal(appPhase.walletImportUnderWay(), false);
  });
});
