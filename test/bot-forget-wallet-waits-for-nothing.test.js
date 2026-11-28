"use strict";

/**
 * @file test/bot-forget-wallet-waits-for-nothing.test.js
 * @description The bot's `forgetWallet` (src/bot/bot-interface.js), which
 *   a Clear and a wallet import call, halts every position and forgets
 *   the key at once, waiting for nothing (the user's design, 2026-11-27:
 *   refuse, never wait). Both are refused while a rebalance or compound
 *   is under way or a position is starting, so a check still running is
 *   only reading, and the halted loop starts no move.
 *
 *   Waiting for every position's check to end, a move included, with the
 *   key still held, would let a Manage whose pool check ended meanwhile
 *   start a loop signing with a cleared wallet's key. Runs over the real
 *   position manager, with a loop whose check never ends.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { botOperations } = require("../src/bot/bot-interface");
const { createPositionManager } = require("../src/bot/position-manager");
const { createRebalanceLock } = require("../src/bot/rebalance-lock");
const appPhase = require("../src/bot/app-phase");

afterEach(() => appPhase._resetAppPhaseForTests());

describe("forgetting the wallet, as a Clear and an import do", () => {
  it("halts every position and forgets the key at once, its checks still running", async () => {
    const positionMgr = createPositionManager({
      rebalanceLock: createRebalanceLock(),
    });
    let halts = 0;
    await positionMgr.startPosition("pulsechain-0xW-0xPM-1", {
      tokenId: "1",
      startLoop: async () => ({
        halt: () => {
          halts += 1;
        },
        stop: () => new Promise(() => {}), // a check that never ends
      }),
    });
    const privateKeyRef = { current: "0xkey" };
    const bot = botOperations({
      diskConfig: { global: {}, positions: {} },
      walletManager: { getAddress: () => "0xW" },
      positionMgr,
      privateKeyRef,
    });
    appPhase.holdMoves(); // as an import holds them while it saves
    const result = bot.forgetWallet();
    assert.equal(result, undefined, "nothing to wait for");
    assert.equal(halts, 1, "the position halted");
    assert.equal(positionMgr.runningCount(), 0);
    assert.equal(bot.hasPrivateKey(), false, "the key forgotten at once");
    assert.equal(appPhase.movesHeld(), false, "the import's hold ended");
  });
});
