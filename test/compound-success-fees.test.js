/**
 * @file test/compound-success-fees.test.js
 * @description A successful compound, through the bot's compound step
 *   (`executeCompound`, src/lib/bot-cycle-compound.js), counts only fees as
 *   fees. The running Lifetime Fees Compounded total takes every fee it
 *   collected, those it left in the wallet included, and never the coins
 *   the wallet already held that its deposit took in. Its Telegram message
 *   names the fees it put back, and apart those coins.
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

/*- A compound whose deposit took only what fit the range: it collected
 *  12 A and 10 B, put back 10 and 10, and left 2 A in the wallet. */
const LEFT_BEHIND = Object.freeze({
  ...SWEPT,
  amount0Deposited: "10",
  amount1Deposited: "10",
  depositedAmount0: 10,
  depositedAmount1: 10,
  amount0FeesLeft: "2",
  amount1FeesLeft: "0",
  feesCollected: { amount0: 12, amount1: 10 },
  usdValue: 20,
  collectedUsd: 22,
});

/** What the stand-in compound reports next. */
let standIn = SWEPT;

const notified = [];

/** Whether `mod` is the file `name` in src/lib/. */
const from = (mod, name) => path.basename(mod.filename || "") === name;

const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (from(this, "bot-cycle-compound.js")) {
    if (id === "./compounder")
      return { executeCompound: async () => ({ ...standIn }) };
    if (id === "./deposit-count")
      return { countDeposits: async () => ({ counted: true, added: false }) };
    if (id === "./telegram-notifications/telegram")
      return { notify: (event, data) => notified.push({ event, data }) };
  }
  return _origRequire.apply(this, arguments);
};
const { executeCompound } = require("../src/lib/bot-cycle-compound");
Module.prototype.require = _origRequire;

/**
 * Run the bot's compound step on what the stand-in compound reports,
 * against a saved total of 5 + 5 coins. The messages it sends are the
 * only ones `notified` then holds.
 *
 * @returns {Promise<object>}  The patch that recorded the compound.
 */
async function compoundAgainstTotal() {
  const patches = [];
  notified.length = 0;
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
        k === "compoundedAmount0" || k === "compoundedAmount1" ? 5 : undefined,
      updateBotState: (p) => patches.push(p),
    },
    { decimals0: 0, decimals1: 0 },
    {},
    "manual",
  );
  return patches.find((p) => p.compoundHistory !== undefined);
}

describe("a compound that left fees in the wallet", () => {
  it("adds every fee it collected to the Lifetime total, those left over included", async () => {
    standIn = LEFT_BEHIND;
    try {
      const recorded = await compoundAgainstTotal();
      assert.equal(recorded.compoundedAmount0, 17, "5 saved + 12 collected");
      assert.equal(recorded.compoundedAmount1, 15, "5 saved + 10 collected");
    } finally {
      standIn = SWEPT;
    }
  });
});

describe("a compound whose deposit swept a deposit in", () => {
  it("adds only the fees it collected, and reports the fees it put back", async () => {
    const recorded = await compoundAgainstTotal();
    assert.equal(recorded.compoundedAmount0, 15, "5 saved + 10 of fees");
    assert.equal(recorded.compoundedAmount1, 15);
    const success = notified.find((n) => n.event === "compoundSuccess");
    assert.equal(
      success.data.message,
      "Compounded $20.00 in fees, and put $200.00 of coins the wallet already held into the position",
    );
  });
});
