/**
 * @file test/deposit-count-first-step.test.js
 * @description The deposit count is the first step of every rebalance
 *   and compound, so the move's records hold the owner's deposits as
 *   money put in (src/lib/deposit-count.js).
 *
 *   It is the only count a due rebalance makes. The Impermanent Loss
 *   Guard counts no coin in the wallet (src/lib/bot-pnl-il.js), so it counts
 *   no deposit before it measures.
 *
 *   The count, the gates, the rebalance and the compound are stand-ins
 *   that note the order they ran in, so nothing here reaches the chain.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");

let order = [];

/** Whether `mod` is the file `name` in src/lib/. */
const from = (mod, name) => path.basename(mod.filename || "") === name;

const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const inCycle = from(this, "bot-cycle.js");
  const inCompound = from(this, "bot-cycle-compound.js");
  if (id === "./deposit-count" && (inCycle || inCompound))
    return {
      countDeposits: async (_d, kind) => {
        order.push("count:" + kind);
        return { counted: true, added: false };
      },
    };
  if (id === "./bot-cycle-gates" && inCycle)
    return {
      gatesBeforeGuard: () => null,
      snapForGuard: async (_d, _p, _e, _f, snap) => snap,
      gatesFromGuard: () => null,
    };
  if (id === "./rebalancer" && inCycle)
    return {
      executeRebalance: async () => {
        order.push("rebalance");
        return { success: false, error: "stand-in" };
      },
      enrichResultUsd: async () => {},
    };
  if (id === "./compounder" && inCompound)
    return {
      executeCompound: async () => {
        order.push("compound");
        return { compounded: false, reason: "no_fees" };
      },
    };
  return _origRequire.apply(this, arguments);
};
const { _executeAndRecord, _runRangeAndExec } = require("../src/lib/bot-cycle");
const { executeCompound } = require("../src/lib/bot-cycle-compound");
Module.prototype.require = _origRequire;

/** Deps for an out-of-range position whose operator asked for a rebalance. */
function deps(botState = {}) {
  return {
    signer: { getAddress: async () => "0x" + "11".repeat(20) },
    address: "0x" + "11".repeat(20),
    provider: {},
    position: {
      tokenId: "7",
      token0: "0x" + "a1".repeat(20),
      token1: "0x" + "b2".repeat(20),
      fee: 3000,
      tickLower: -100,
      tickUpper: 100,
      liquidity: "1000",
    },
    throttle: { canRebalance: () => ({ allowed: true }) },
    _botState: botState,
    _getConfig: () => undefined,
    updateBotState: () => {},
  };
}

beforeEach(() => {
  order = [];
});

describe("a rebalance's first step", () => {
  it("counts the deposits before anything else", async () => {
    await _executeAndRecord(deps(), {});
    assert.deepEqual(order, ["count:move", "rebalance"]);
  });

  it("is the one count a due rebalance makes, past the gates and the Guard", async () => {
    await _runRangeAndExec(
      deps({ forceRebalance: true }),
      {},
      { tick: 500 },
      () => {},
      false,
      {},
    );
    assert.deepEqual(order, ["count:move", "rebalance"]);
  });
});

describe("a compound's first step", () => {
  it("counts the deposits before the compound moves the wallet's coins", async () => {
    await executeCompound(
      deps({ forceCompound: true }),
      { decimals0: 18, decimals1: 18 },
      {},
      "manual",
    );
    assert.deepEqual(order, ["count:move", "compound"]);
  });
});
