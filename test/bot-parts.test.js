"use strict";

/**
 * @file test/bot-parts.test.js
 * @description The bot's parts, built the one way both programs build them
 *   (`buildBotParts`, src/bot/bot-interface.js), start with each pool's
 *   count of today's rebalances read from the rebalance log, so a restart
 *   mid-day keeps every pool's Max Rebalances / Day. Bug #19: the headless
 *   bot built its parts itself and left the count empty, so after a
 *   restart its first check could rebalance a pool already at its cap.
 *   test/bot-start-up-shared.test.js pins that src/bot.js builds its bot
 *   through `createBot`, which builds these parts.
 */

const { describe, it, mock, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/lib/config");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { poolKey } = require("../src/lib/pool-key");
const { buildBotParts } = require("../src/bot/bot-interface");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const A = { token0: "0xA0", token1: "0xA1", fee: 3000 };
const B = { token0: "0xB0", token1: "0xB1", fee: 10000 };

/** A rebalance-log entry for `pool`, logged at the UTC time `iso`. */
const entry = (pool, iso) => ({
  chain: "pulsechain",
  contract: PM,
  wallet: WALLET,
  ...pool,
  loggedAt: iso,
});
const keyOf = (pool) =>
  poolKey("pulsechain", PM, WALLET, pool.token0, pool.token1, pool.fee);

describe("the bot's parts", () => {
  const savedLogFile = config.LOG_FILE;
  after(() => {
    config.LOG_FILE = savedLogFile;
    mock.timers.reset();
  });

  it("count each pool's rebalances today from the rebalance log", () => {
    /*- The day is fixed, so no run can cross midnight between writing
     *  the log and reading it. */
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 23, 12) });
    const logFile = path.join(makeTestTempFolder("bot-parts"), "log.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify([
        entry(A, "2026-11-22T23:30:00.000Z"),
        entry(A, "2026-11-23T01:00:00.000Z"),
        entry(A, "2026-11-23T09:15:00.000Z"),
        entry(B, "2026-11-23T11:00:00.000Z"),
      ]),
    );
    config.LOG_FILE = logFile;

    const { positionMgr } = buildBotParts();

    assert.deepEqual(positionMgr.getPoolDailyCounts(), {
      [keyOf(A)]: 2,
      [keyOf(B)]: 1,
    });
    assert.equal(positionMgr.canRebalancePool(keyOf(A), 2), false);
    assert.equal(positionMgr.canRebalancePool(keyOf(B), 2), true);
  });
});
