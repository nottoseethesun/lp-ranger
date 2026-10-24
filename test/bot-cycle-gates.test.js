"use strict";

/**
 * @file test/bot-cycle-gates.test.js
 * @description The Impermanent Loss Guard measures with fresh prices
 *   (`snapForGuard`, src/bot-cycle-gates.js).
 *
 *   The Guard compares the position with holding its NFT's minted coins
 *   at today's prices, read from the poll's figures. While price lookups
 *   are paused, those carry the last prices fetched, of any age, and a
 *   rebalance is due because the price moved, so an old price makes the
 *   loss look smaller. The figures are worked out again with fresh prices
 *   when the Guard will measure, and only then, so a lookup is spent only
 *   on a rebalance the bot is about to make.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  pausePriceLookups,
  _resetPauseStateForTests,
  inMove,
} = require("../src/price-fetcher-gate");
const { snapForGuard, gatesFromGuard } = require("../src/bot-cycle-gates");

const STALE = { totalIL: 50 };
const POSITION = {
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "b2".repeat(20),
  // A live position: the Guard stands aside for one holding no liquidity.
  liquidity: "1000",
};

/** Bot deps for a position whose Guard has made no rejection. */
const deps = (botState = {}) => ({ position: POSITION, _botState: botState });

/** A stand-in for the poll's figures update, noting whether prices were fresh. */
function updater(result) {
  const calls = [];
  const update = async () => {
    calls.push({ fresh: inMove() });
    return result;
  };
  return { update, calls };
}

afterEach(() => _resetPauseStateForTests());

describe("the figures the Guard measures with", () => {
  it("are the poll's own while prices are not paused", async () => {
    const u = updater({ totalIL: -900 });
    const snap = await snapForGuard(deps(), {}, null, false, STALE, u.update);
    assert.equal(snap, STALE);
    assert.equal(u.calls.length, 0, "no lookup spent");
  });

  it("are worked out again with fresh prices while prices are paused", async () => {
    pausePriceLookups("test");
    const fresh = { totalIL: -900 };
    const u = updater(fresh);
    const snap = await snapForGuard(deps(), {}, null, false, STALE, u.update);
    assert.equal(snap, fresh);
    assert.deepEqual(u.calls, [{ fresh: true }], "inside a fresh-price scope");
  });

  it("are the poll's own for a Rebalance Now, which the Guard stands aside for", async () => {
    pausePriceLookups("test");
    const u = updater({});
    const snap = await snapForGuard(deps(), {}, null, true, STALE, u.update);
    assert.equal(snap, STALE);
    assert.equal(u.calls.length, 0);
  });

  it("are the poll's own while the Guard waits out a rejection", async () => {
    pausePriceLookups("test");
    const u = updater({});
    const waiting = deps({
      _ilGuardRejectedAt: Date.now(),
      _ilGuardRejectCount: 1,
    });
    const snap = await snapForGuard(waiting, {}, null, false, STALE, u.update);
    assert.equal(snap, STALE);
    assert.equal(u.calls.length, 0);
  });
});

describe("the Guard on fresh figures", () => {
  it("refuses the rebalance the stale figures would have let through", async () => {
    /*-
     *  Holding the minted coins is worth $1,000 at both prices; at the
     *  old price the position reads $50 above holding, at today's $190
     *  below it, past the 15% the Guard allows.
     */
    pausePriceLookups("test");
    const inputs = (il) => ({
      totalIL: il,
      ilInputs: {
        price0: 1,
        price1: 1,
        cur: { hodlAmount0: 500, hodlAmount1: 500 },
      },
    });
    const d = {
      ...deps(),
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? 15 : undefined),
      updateBotState: () => {},
    };
    const notifyPos = (p) => ({ tokenId: p.tokenId });
    assert.equal(gatesFromGuard(d, {}, false, inputs(50), notifyPos), null);
    const u = updater(inputs(-190));
    const snap = await snapForGuard(d, {}, null, false, inputs(50), u.update);
    const gate = gatesFromGuard(d, {}, false, snap, notifyPos);
    assert.equal(gate?.ilGuardRejected, true);
  });
});
