"use strict";

/**
 * @file test/il-guard-after-rebalance.test.js
 * @description A rebalance that succeeds ends the Impermanent Loss
 * Guard's block: its wait is forgotten and its alert taken down.
 *
 * The Guard measures each NFT against the coins that NFT was minted
 * with, and a rebalance mints a new one. The bot state holding the
 * Guard's wait and alert moves to the new NFT's key, so without an end
 * to the block a Rebalance Now past it would leave the new NFT's
 * automatic rebalances refused for the rest of the old wait, up to a
 * week, and the dashboard would raise the old NFT's alert again under
 * the new key. Driven through the poll cycle a Rebalance Now runs, with
 * the rebalance answered by the stand-in chain the bot-loop tests use.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const { _poll } = require("./_bot-loop-helpers");
const { checkIlGuard } = require("../src/lib/il-guard");
const { ilSnapshot } = require("./helpers/il-snapshot");

/** A Rebalance Now's bot state, with a Guard block standing. */
function blockedState() {
  return {
    forceRebalance: true,
    rebalanceOutOfRangeThresholdPercent: 20,
    slippagePct: 0.5,
    // The third rejection in a row, a minute ago: a 16-hour wait.
    _ilGuardRejectedAt: Date.now() - 60_000,
    _ilGuardRejectCount: 3,
    ilGuardBlocked: { message: "The old NFT's figures." },
  };
}

const notifyPos = (p) => ({ tokenId: p.tokenId });

describe("a successful rebalance ends the Impermanent Loss Guard's block", () => {
  it("forgets the wait and takes the alert down", async () => {
    const botState = blockedState();
    const { r, stateUpdates } = await _poll(0, {
      botState,
      collectStates: true,
    });
    assert.equal(r.rebalanced, true, "the Rebalance Now must go through");
    assert.equal(botState._ilGuardRejectedAt, 0);
    assert.equal(botState._ilGuardRejectCount, 0);
    assert.ok(
      stateUpdates.some((u) => u.ilGuardBlocked === null),
      "the alert must be taken down, or the dashboard raises it again " +
        "under the new NFT's key",
    );
  });

  it("lets the new NFT's next automatic check measure it at once", async () => {
    const botState = blockedState();
    await _poll(0, { botState });
    /*-
     *  The new NFT is just above its floor: a measured check lets it
     *  rebalance. The old NFT's wait, had it survived, would refuse it
     *  as still cooling down without measuring at all.
     */
    const decision = checkIlGuard(
      {
        position: { tokenId: "2" },
        _getConfig: () => 50,
        _botState: botState,
      },
      false,
      ilSnapshot(640, 1000),
      notifyPos,
    );
    assert.equal(decision, null);
  });

  it("publishes nothing about the Guard when no block stands", async () => {
    const { r, stateUpdates } = await _poll(0, {
      botState: {
        forceRebalance: true,
        rebalanceOutOfRangeThresholdPercent: 20,
        slippagePct: 0.5,
      },
      collectStates: true,
    });
    assert.equal(r.rebalanced, true);
    assert.ok(
      !stateUpdates.some((u) => Object.hasOwn(u, "ilGuardBlocked")),
      "an alert is taken down only where one stands",
    );
  });
});
