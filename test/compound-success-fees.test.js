/**
 * @file test/compound-success-fees.test.js
 * @description A successful compound, through the bot's compound step
 *   (`executeCompound`, src/bot-cycle-compound.js), counts only the fees
 *   its deposit put back: in the running Fees Compounded total and in its
 *   Telegram message, which names apart the coins the wallet already held
 *   that the deposit took in.
 *
 *   The case the user reported: a deposit of 100 A + 100 B waited in the
 *   wallet, the compound collected 10 + 10 of fees, and its swap's deposit
 *   took all 110 + 110. The compound itself, the deposit count and
 *   Telegram are stand-ins, so nothing here reaches the chain.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");

/** What the stand-in compound reports: the case the user reported. */
const SWEPT = Object.freeze({
  compounded: true,
  trigger: "manual",
  timestamp: "2026-10-23T12:00:00.000Z",
  collectTxHash: "0xc",
  depositTxHash: "0xd",
  amount0Deposited: "110",
  amount1Deposited: "110",
  depositedAmount0: 110,
  depositedAmount1: 110,
  amount0Compounded: "10",
  amount1Compounded: "10",
  feesCompounded: { amount0: 10, amount1: 10 },
  feesCollected: { amount0: 10, amount1: 10 },
  liquidity: "1",
  usdValue: 220,
  collectedUsd: 20,
  price0: 1,
  price1: 1,
  gasCostWei: "0",
});

const notified = [];

/** Whether `mod` is the file `name` in src/. */
const from = (mod, name) => path.basename(mod.filename || "") === name;

const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (from(this, "bot-cycle-compound.js")) {
    if (id === "./compounder")
      return { executeCompound: async () => ({ ...SWEPT }) };
    if (id === "./deposit-count")
      return { countDeposits: async () => ({ counted: true, added: false }) };
    if (id === "./telegram-notifications/telegram")
      return { notify: (event, data) => notified.push({ event, data }) };
  }
  return _origRequire.apply(this, arguments);
};
const { executeCompound } = require("../src/bot-cycle-compound");
Module.prototype.require = _origRequire;

describe("a compound whose deposit swept a deposit in", () => {
  it("adds and reports only the fees it put back", async () => {
    const patches = [];
    await executeCompound(
      {
        signer: { getAddress: async () => "0x" + "11".repeat(20) },
        address: "0x" + "11".repeat(20),
        position: {
          tokenId: "7",
          token0: "0x" + "a1".repeat(20),
          token1: "0x" + "b2".repeat(20),
          fee: 3000,
          liquidity: "1000",
        },
        _botState: { forceCompound: true },
        _getConfig: (k) =>
          k === "compoundedAmount0" || k === "compoundedAmount1"
            ? 5
            : undefined,
        updateBotState: (p) => patches.push(p),
      },
      { decimals0: 0, decimals1: 0 },
      {},
      "manual",
    );
    const recorded = patches.find((p) => p.compoundHistory !== undefined);
    assert.equal(recorded.compoundedAmount0, 15, "5 saved + 10 of fees");
    assert.equal(recorded.compoundedAmount1, 15);
    const success = notified.find((n) => n.event === "compoundSuccess");
    assert.equal(
      success.data.message,
      "Compounded $20.00 in fees, and put $200.00 of coins the wallet already held into the position",
    );
  });
});
