"use strict";

/**
 * @file test/config-record-checks.test.js
 * @description Every value `POST /api/config` accepts is checked before
 *   anything is saved, the bot's own records included.
 *
 *   The route accepts ten records the bot keeps per position, the HODL
 *   baseline, the wallet residuals and the compound tallies among them,
 *   and it checked none: a request could save a residual the next start
 *   cannot read (`BigInt("abc")` throws) or a baseline with no coins in
 *   it. The user, 2026-10-18: "just ensure that the server/bot always
 *   validates any incoming values against the same datatype and range
 *   checks that the test suite uses." Each record is now held to the
 *   shape the bot writes, built from the kinds the shipped-values test
 *   uses (src/value-kinds.js), so these cases check that every accepted
 *   key has a check, that what the bot writes passes, and that a value of
 *   the wrong kind is refused with nothing applied.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { checkConfigValues, RULES } = require("../src/config-bounds");
const { GLOBAL_KEYS, POSITION_KEYS } = require("../src/bot-config-keys");
const { createResidualTracker } = require("../src/residual-tracker");
const { createRouteHandlers } = require("../src/server-routes");

const check = (patch) => checkConfigValues(patch, { compoundMinFeeUsd: 1 });
const POOL = "0x" + "ab".repeat(20);

/*-
 *  Each record as the bot writes it; the writers are named beside each
 *  rule in src/config-record-checks.js.
 */
const residualTracker = createResidualTracker();
residualTracker.addDelta(POOL, 100n, 0n);
const AS_WRITTEN = {
  hodlBaseline: {
    entryValue: 1234.5,
    token0UsdPrice: 0.0001,
    token1UsdPrice: 1.2,
    hodlAmount0: 100,
    hodlAmount1: 5,
    mintDate: "2026-01-02",
    mintTimestamp: 1767312000,
    mintGasWei: "123456789",
  },
  residuals: residualTracker.serialize(),
  compoundHistory: [
    {
      timestamp: "2026-10-18T07:00:00.000Z",
      txHash: "0x" + "cd".repeat(32),
      tokenId: "157149",
      amount0Deposited: "1000",
      amount1Deposited: "2000",
      usdValue: 1.5,
      price0: 0.1,
      price1: 2,
      gasCostUsd: 0.01,
      trigger: "auto",
    },
    {
      timestamp: null,
      txHash: null,
      tokenId: "157149",
      amount0Deposited: "1",
      amount1Deposited: "2",
      usdValue: 0,
      trigger: "historical",
    },
  ],
  compoundedAmount0: 12.5,
  compoundedAmount1: 0,
  nftGasWeiByTokenId: { 157149: "21000000000000" },
  nftCompoundedAmountsByTokenId: { 157149: { amount0: 4, amount1: 1 } },
  lastCompoundAt: "2026-10-18T07:00:00.000Z",
  totalLifetimeDepositUsd: 500.25,
  depositUsedFallback: false,
};

describe("the values POST /api/config accepts", () => {
  it("each have a check", () => {
    for (const key of [...GLOBAL_KEYS, ...POSITION_KEYS])
      assert.equal(typeof RULES[key], "function", key);
  });

  it("include the bot's records as the bot writes them", () => {
    for (const [key, value] of Object.entries(AS_WRITTEN))
      assert.equal(check({ [key]: value }), null, key);
    // A price the mint lookup could not find, and an older release's date.
    const older = {
      ...AS_WRITTEN.hodlBaseline,
      token0UsdPrice: null,
      mintTimestamp: "2026-01-02T00:00:00.000Z",
    };
    assert.equal(check({ hodlBaseline: older }), null);
  });
});

describe("a record of the wrong kind", () => {
  const refused = (key, value, message) => {
    const bad = check({ [key]: value });
    assert.equal(bad?.key, key, JSON.stringify(value));
    assert.match(bad.message, message);
  };

  it("is refused, naming the field and what it must be", () => {
    refused(
      "hodlBaseline",
      { ...AS_WRITTEN.hodlBaseline, entryValue: "12" },
      /hodlBaseline\.entryValue must be a number of dollars, at least 0; it is "12"\./,
    );
    refused("hodlBaseline", { entryValue: 12 }, /hodlAmount0 is missing/);
    refused(
      "residuals",
      { [POOL]: { token0: "abc", token1: "1" } },
      /residuals\.0x[a-f0-9]+\.token0 must be a whole number written in digits/,
    );
    refused("compoundHistory", "x", /compoundHistory must be a list/);
    refused(
      "compoundHistory",
      [{ amount0Deposited: 5, amount1Deposited: "1" }],
      /compoundHistory\[0\]\.amount0Deposited must be a whole number/,
    );
    refused("compoundedAmount0", "100", /must be a number of coins/);
    refused("compoundedAmount1", -1, /must be a number of coins/);
    refused("nftGasWeiByTokenId", { 1: 5 }, /nftGasWeiByTokenId\.1 must be/);
    refused(
      "nftCompoundedAmountsByTokenId",
      { 1: { amount0: "4", amount1: 1 } },
      /\.1\.amount0 must be a number of coins/,
    );
    refused("lastCompoundAt", 1771200000000, /ISO 8601/);
    refused("totalLifetimeDepositUsd", -5, /number of dollars/);
    refused("depositUsedFallback", "true", /must be true or false/);
  });

  it("leaves the configuration untouched when the route refuses it", async () => {
    const diskConfig = { global: {}, positions: {} };
    const res = {};
    await createRouteHandlers({
      diskConfig,
      positionMgr: { getAll: () => [], get: () => null },
      privateKeyRef: { current: null },
      walletManager: { getStatus: () => ({ loaded: false }) },
      jsonResponse: (r, status, body) => Object.assign(r, { status, body }),
      readJsonBody: async () => ({
        positionKey: "pulsechain-0x1-0x2-100",
        residuals: { [POOL]: { token0: "abc", token1: "1" } },
      }),
      getAllPositionBotStates: () => new Map(),
      createPerPositionBotState: () => ({}),
      attachMultiPosDeps: () => {},
      updatePositionState: () => {},
    })._handleApiConfig({}, res);
    assert.equal(res.status, 400);
    assert.equal(res.body.invalidValueForKey, "residuals");
    assert.deepEqual(diskConfig.positions, {}, "no slot created");
  });
});
