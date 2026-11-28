"use strict";

/**
 * @file test/pool-daily-counts-file.test.js
 * @description Each pool's rebalances today, kept in a file of their own
 *   (src/bot/pool-daily-counts-file.js), so a restart counts every
 *   rebalance made today toward Max Rebalances / Day, whether or not the
 *   rebalance log holds it. The position manager saves the counts at
 *   every rebalance and takes them back as the bot starts, each pool
 *   keeping the larger of the saved count and the log's. A file from
 *   another day counts nothing, nor does one that cannot be read. Runs
 *   over the file the test process has under `node --test`.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createPositionManager } = require("../src/bot/position-manager");
const {
  poolDailyCountsPath,
  readPoolDailyCounts,
  utcDay,
} = require("../src/bot/pool-daily-counts-file");
const { poolKey } = require("../src/lib/pool-key");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const POOL = poolKey("pulsechain", PM, WALLET, "0xA0", "0xA1", 3000);
const NOON = Date.UTC(2026, 10, 23, 12);
const NEXT_DAY = Date.UTC(2026, 10, 24, 12);

/** A position manager whose clock reads `now`, as after a start. */
const managerAt = (now) =>
  createPositionManager({ rebalanceLock: null, nowFn: () => now });

/** A rebalance-log entry for the pool, logged at the UTC time `iso`. */
const logEntry = (iso) => ({
  chain: "pulsechain",
  contract: PM,
  wallet: WALLET,
  token0: "0xA0",
  token1: "0xA1",
  fee: 3000,
  loggedAt: iso,
});

beforeEach(() => fs.rmSync(poolDailyCountsPath(), { force: true }));

describe("today's rebalance counts, kept apart from the rebalance log", () => {
  it("are taken back by a restart the same day, though the log holds none of them", () => {
    const before = managerAt(NOON);
    before.recordPoolRebalance(POOL);
    before.recordPoolRebalance(POOL);
    const after = managerAt(NOON + 60_000);
    after.seedPoolDailyCounts([]);
    assert.equal(after.restoreSavedPoolDailyCounts(), 1, "one pool raised");
    assert.equal(after.getPoolDailyCount(POOL), 2);
    assert.equal(
      after.canRebalancePool(POOL, 2),
      false,
      "the cap holds across the restart",
    );
  });

  it("keep, for each pool, the larger of the saved count and the log's", () => {
    managerAt(NOON).recordPoolRebalance(POOL);
    const restarted = managerAt(NOON);
    restarted.seedPoolDailyCounts([
      logEntry("2026-11-23T01:00:00.000Z"),
      logEntry("2026-11-23T02:00:00.000Z"),
    ]);
    assert.equal(
      restarted.restoreSavedPoolDailyCounts(),
      0,
      "the log's is larger",
    );
    assert.equal(restarted.getPoolDailyCount(POOL), 2);
  });

  it("count nothing the next day", () => {
    managerAt(NOON).recordPoolRebalance(POOL);
    const nextDay = managerAt(NEXT_DAY);
    assert.equal(nextDay.restoreSavedPoolDailyCounts(), 0);
    assert.equal(nextDay.getPoolDailyCount(POOL), 0);
  });

  it("count nothing from a file that cannot be read", () => {
    fs.mkdirSync(path.dirname(poolDailyCountsPath()), { recursive: true });
    fs.writeFileSync(poolDailyCountsPath(), "{ not json");
    assert.deepEqual(readPoolDailyCounts(utcDay(NOON)), {});
  });
});
