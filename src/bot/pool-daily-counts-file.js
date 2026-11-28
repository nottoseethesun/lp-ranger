"use strict";

/**
 * @file src/bot/pool-daily-counts-file.js
 * @module pool-daily-counts-file
 * @description
 * Each pool's rebalances today, kept in a file of their own,
 * `app-data/pool-daily-counts.json`, apart from the rebalance log, so a
 * restart counts every rebalance made today toward Max Rebalances / Day:
 * one whose log entry could not be written, those in a log that cannot
 * be read, and those in a log `--delete-all-caches-and-logs` removed
 * included (the user's decision, 2026-11-27). The position manager
 * (src/bot/position-manager.js) saves the counts at each rebalance, and
 * takes them back as the bot starts, beside the counts it reads from the
 * rebalance log, keeping the larger for each pool.
 *
 * The file holds one UTC day: one from an earlier day counts nothing. It
 * is small, so it is replaced whole through a copy (src/bot/shared-json-file.js),
 * and a write cut short leaves the last counts whole. A failed save is
 * told as every file failure is (src/lib/file-problem.js), never thrown:
 * the count in memory holds until the next start.
 * Under `node --test` it is a file of the test process's own.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

const path = require("path");
const { tellFileProblem } = require("../lib/file-problem");
const { makeTestTempFolder } = require("../lib/test-temp-folders");
const { readJsonObject, replaceJsonFile } = require("./shared-json-file");

/** The file's name, in `app-data/`. */
const COUNTS_FILE = "pool-daily-counts.json";

/** This test process's folder, made the first time one is asked for. */
let _testDir = null;

/**
 * Where the counts are kept.
 * @returns {string}
 */
function poolDailyCountsPath() {
  if (process.env.NODE_TEST_CONTEXT === undefined)
    return path.join(process.cwd(), "app-data", COUNTS_FILE);
  if (_testDir === null) _testDir = makeTestTempFolder("pool-daily-counts");
  return path.join(_testDir, COUNTS_FILE);
}

/**
 * The UTC day of a moment, as the file names it: "YYYY-MM-DD".
 * @param {number} ms  Milliseconds since the epoch.
 * @returns {string}
 */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Each pool's rebalances on `day`, by pool key, as saved: none when there
 * is no file, when it is from another day, or when it cannot be read. A
 * count that is not a whole number above zero is left out.
 * @param {string} day  The UTC day, as `utcDay` gives it.
 * @returns {Record<string, number>}
 */
function readPoolDailyCounts(day) {
  const saved = readJsonObject(poolDailyCountsPath());
  if (saved.day !== day) return {};
  const counts = saved.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts))
    return {};
  const out = {};
  for (const [pk, n] of Object.entries(counts))
    if (Number.isInteger(n) && n > 0) out[pk] = n;
  return out;
}

/**
 * Save each pool's rebalances on `day`, replacing the file whole.
 * @param {string} day  The UTC day, as `utcDay` gives it.
 * @param {Record<string, number>} counts  By pool key.
 */
function savePoolDailyCounts(day, counts) {
  const file = poolDailyCountsPath();
  try {
    replaceJsonFile(file, { day, counts });
  } catch (err) {
    tellFileProblem({
      doing: "write to",
      file,
      err,
      what: `its count of today's rebalances, ${file}`,
    });
  }
}

module.exports = {
  poolDailyCountsPath,
  utcDay,
  readPoolDailyCounts,
  savePoolDailyCounts,
};
