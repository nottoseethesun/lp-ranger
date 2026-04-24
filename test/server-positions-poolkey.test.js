/**
 * @file test/server-positions-poolkey.test.js
 * @description Unit tests for attachPoolKeys() in src/server-positions.js.
 *
 * Validates that the dashboard status response gets a canonical poolKey
 * on each managed entry so per-pool daily rebalance counts line up
 * with the server's `global.poolDailyCounts` map (single source of
 * truth: position-manager.poolKey()).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { attachPoolKeys } = require("../src/server-positions");

// Spy that records the arguments it's called with and returns a
// deterministic key so we can assert both plumbing and that the
// server is using its canonical poolKey() function.
function makePositionMgr() {
  const calls = [];
  return {
    calls,
    poolKey(chain, contract, wallet, t0, t1, fee) {
      calls.push({ chain, contract, wallet, t0, t1, fee });
      return [chain, contract, wallet, t0, t1, fee].join("|").toLowerCase();
    },
  };
}

const CFG = {
  CHAIN_NAME: "pulsechain",
  POSITION_MANAGER: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
};

describe("attachPoolKeys()", () => {
  it("attaches a canonical poolKey to entries with activePosition", () => {
    const positions = {
      "pulsechain-0xA-0xB-1": {
        walletAddress: "0xWallet",
        activePosition: { token0: "0xAAA", token1: "0xBBB", fee: 3000 },
      },
    };
    const mgr = makePositionMgr();
    attachPoolKeys(positions, mgr, CFG);
    assert.strictEqual(
      positions["pulsechain-0xA-0xB-1"].poolKey,
      "pulsechain|" +
        CFG.POSITION_MANAGER.toLowerCase() +
        "|0xwallet|0xaaa|0xbbb|3000",
    );
    assert.strictEqual(mgr.calls.length, 1);
    assert.deepStrictEqual(mgr.calls[0], {
      chain: "pulsechain",
      contract: CFG.POSITION_MANAGER,
      wallet: "0xWallet",
      t0: "0xAAA",
      t1: "0xBBB",
      fee: 3000,
    });
  });

  it("accepts fee=0 (valid fee tier edge case — uses !== undefined guard)", () => {
    // Defensive: if a future fee tier of 0 is introduced, the attach
    // logic must still compute a key (the bug we're guarding against is
    // a truthy check filtering out fee=0).
    const positions = {
      k: {
        walletAddress: "0xW",
        activePosition: { token0: "0xA", token1: "0xB", fee: 0 },
      },
    };
    attachPoolKeys(positions, makePositionMgr(), CFG);
    assert.ok(positions.k.poolKey, "poolKey should be set even when fee is 0");
  });

  it("skips entries missing walletAddress", () => {
    const positions = {
      k: { activePosition: { token0: "0xA", token1: "0xB", fee: 3000 } },
    };
    attachPoolKeys(positions, makePositionMgr(), CFG);
    assert.strictEqual(positions.k.poolKey, undefined);
  });

  it("skips entries missing activePosition (unmanaged positions)", () => {
    const positions = { k: { walletAddress: "0xW" } };
    attachPoolKeys(positions, makePositionMgr(), CFG);
    assert.strictEqual(positions.k.poolKey, undefined);
  });

  it("skips entries where activePosition is missing a token field", () => {
    const positions = {
      a: {
        walletAddress: "0xW",
        activePosition: { token0: "0xA", fee: 3000 },
      },
      b: {
        walletAddress: "0xW",
        activePosition: { token1: "0xB", fee: 3000 },
      },
    };
    attachPoolKeys(positions, makePositionMgr(), CFG);
    assert.strictEqual(positions.a.poolKey, undefined);
    assert.strictEqual(positions.b.poolKey, undefined);
  });

  it("processes every entry in the map independently", () => {
    const positions = {
      managed: {
        walletAddress: "0xW1",
        activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
      },
      unmanaged: { walletAddress: "0xW2" },
      alsoManaged: {
        walletAddress: "0xW3",
        activePosition: { token0: "0xC", token1: "0xD", fee: 500 },
      },
    };
    const mgr = makePositionMgr();
    attachPoolKeys(positions, mgr, CFG);
    assert.ok(positions.managed.poolKey);
    assert.strictEqual(positions.unmanaged.poolKey, undefined);
    assert.ok(positions.alsoManaged.poolKey);
    assert.strictEqual(mgr.calls.length, 2);
  });

  it("handles an empty positions map without error", () => {
    assert.doesNotThrow(() => attachPoolKeys({}, makePositionMgr(), CFG));
  });
});
