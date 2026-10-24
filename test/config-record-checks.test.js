"use strict";

/**
 * @file test/config-record-checks.test.js
 * @description The records the bot keeps per position, the HODL
 *   baseline, the wallet residuals and the compound tallies among them,
 *   are each held to the shape the bot writes.
 *
 *   The user, 2026-10-18: "just ensure that the server/bot always
 *   validates any incoming values against the same datatype and range
 *   checks that the test suite uses." Each record's rule is built from
 *   the kinds the shipped-values test uses (src/lib/value-kinds.js), and the
 *   startup check holds the records file, app-data/position-records.json,
 *   to it, so a record the next start cannot read, such as a residual
 *   whose `BigInt("abc")` throws, stops startup rather than the bot.
 *   `POST /api/config` takes settings only, so a request cannot write a
 *   record at all. These cases check, through the startup check of the
 *   records file, that every record has a check, that what the bot
 *   writes passes and that a value of the wrong kind is refused; and
 *   that the route leaves records alone.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { RECORD_CHECKS } = require("../src/lib/config-record-checks");
const { positionRecordsProblems } = require("../src/lib/bot-config-checks");
const { RECORD_POSITION_KEYS } = require("../src/lib/bot-config-keys");
const { createResidualTracker } = require("../src/lib/residual-tracker");
const { createRouteHandlers } = require("../src/lib/server-routes");

const POOL = "0x" + "ab".repeat(20);
const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-" +
  "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-157149";

/*- What the startup check finds wrong with one position's records. */
const problemsWith = (records) =>
  positionRecordsProblems(JSON.stringify({ positions: { [KEY]: records } }));

/*-
 *  Each record as the bot writes it; the writers are named beside each
 *  rule in src/lib/config-record-checks.js.
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
      // The fees among the deposited coins (src/lib/compounded-coins.js).
      amount0Compounded: "400",
      amount1Compounded: "2000",
      // The fees the deposit could not take, left in the wallet.
      amount0FeesLeft: "100",
      amount1FeesLeft: "0",
      // The Activity Log figures (src/lib/compound-activity-figures.js).
      feesCollected: { amount0: 0.5, amount1: 0.25 },
      historical: { percentGainForPosition: 0.01 },
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
    // As a rebuild writes one whose figures could not be worked out.
    {
      timestamp: "2026-10-18T08:00:00.000Z",
      txHash: "0x" + "ce".repeat(32),
      tokenId: "157149",
      amount0Deposited: "3",
      amount1Deposited: "4",
      usdValue: 0.5,
      trigger: "unknown",
      feesCollected: null,
      historical: { percentGainForPosition: null },
    },
  ],
  compoundedAmount0: 12.5,
  compoundedAmount1: 0,
  nftGasWeiByTokenId: { 157149: "21000000000000" },
  nftCompoundedAmountsByTokenId: { 157149: { amount0: 4, amount1: 1 } },
  lastCompoundAt: "2026-10-18T07:00:00.000Z",
  totalLifetimeDepositUsd: 500.25,
  depositUsedFallback: false,
  // As recordSpentGas writes it (src/lib/spent-gas.js).
  failedMoveGas: [
    { at: "2026-10-19T15:00:00.000Z", wei: "3000000000000000", usd: 0.12 },
  ],
};

describe("the records the bot keeps", () => {
  it("each have a check", () => {
    for (const key of RECORD_POSITION_KEYS)
      assert.equal(typeof RECORD_CHECKS[key], "function", key);
  });

  it("pass as the bot writes them", () => {
    assert.deepEqual(
      Object.keys(AS_WRITTEN).sort(),
      RECORD_POSITION_KEYS.toSorted(),
    );
    assert.deepEqual(problemsWith(AS_WRITTEN), []);
    // A price the mint lookup could not find, and an older release's date.
    const older = {
      ...AS_WRITTEN.hodlBaseline,
      token0UsdPrice: null,
      mintTimestamp: "2026-01-02T00:00:00.000Z",
    };
    assert.deepEqual(problemsWith({ hodlBaseline: older }), []);
  });
});

describe("a record of the wrong kind", () => {
  const refused = (key, value, message) => {
    const problems = problemsWith({ [key]: value });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.ok(problems[0].includes(`${KEY}.${key}:`), problems[0]);
    assert.match(problems[0], message);
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
    const compound = AS_WRITTEN.compoundHistory[0];
    refused(
      "compoundHistory",
      [{ ...compound, historical: { percentGainForPosition: -1 } }],
      /compoundHistory\[0\]\.historical\.percentGainForPosition must be a percentage, at least 0/,
    );
    refused(
      "compoundHistory",
      [{ ...compound, historical: {} }],
      /compoundHistory\[0\]\.historical\.percentGainForPosition is missing/,
    );
    refused(
      "compoundHistory",
      [{ ...compound, feesCollected: { amount0: "1", amount1: 1 } }],
      /compoundHistory\[0\]\.feesCollected\.amount0 must be a number of coins/,
    );
    refused(
      "compoundHistory",
      [{ ...compound, amount1Compounded: 10 }],
      /compoundHistory\[0\]\.amount1Compounded must be a whole number/,
    );
    refused(
      "compoundHistory",
      [{ ...compound, amount0FeesLeft: "-1" }],
      /compoundHistory\[0\]\.amount0FeesLeft must be a whole number/,
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
    refused(
      "failedMoveGas",
      [{ ...AS_WRITTEN.failedMoveGas[0], wei: 3e15 }],
      /failedMoveGas\[0\]\.wei must be a whole number written in digits/,
    );
  });

  it("is not taken by the settings route, which leaves the configuration untouched", async () => {
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
        residuals: { [POOL]: { token0: "1", token1: "1" } },
      }),
      getAllPositionBotStates: () => new Map(),
      createPerPositionBotState: () => ({}),
      attachMultiPosDeps: () => {},
      updatePositionState: () => {},
    })._handleApiConfig({}, res);
    assert.deepEqual(diskConfig.positions, {}, "no slot created");
    assert.equal(res.body.applied?.residuals, undefined, "nothing applied");
  });
});
