"use strict";

/**
 * @file src/lib/position-records.js
 * @module position-records
 * @description
 * The bot's records for each position, kept apart from the operator's
 * settings: `app-data/position-records.json`.
 *
 * A record is what the bot worked out or logged about a position: its
 * HODL baseline, compound history and compounded coins, gas per NFT,
 * lifetime deposit, wallet residuals, and when it last compounded
 * (`RECORD_POSITION_KEYS`, src/lib/bot-config-keys.js). A setting is what the
 * operator chose, and bot-config.json keeps it. Kept apart, resetting the
 * settings leaves the figures, and nothing that edits settings can reach
 * a record.
 *
 * In memory a position has one slot holding both, so every reader of a
 * position's figures reads one place: `loadConfig` merges the records into
 * the slots it reads from bot-config.json, and `saveConfig` writes each
 * key back to its own file (src/lib/bot-config-v2.js). The file is
 * `{ "positions": { "<position key>": { <records> } } }`, written whole
 * and atomically on every save, with a copy taken on each load as
 * bot-config.json's is.
 *
 * Under `node --test`, with no folder named, the file is in a temp folder
 * of the test process's own, as bot-config.json is; a test that names a
 * folder for bot-config.json gets the records file in the same folder.
 * Built on `fs` and the key list alone, so the offline `util/` tools read
 * records the way the app does.
 */

const fs = require("fs");
const path = require("path");
const { RECORD_POSITION_KEYS } = require("./bot-config-keys");
const { makeTestTempFolder } = require("./test-temp-folders");

const RECORDS_FILE = "position-records.json";

/** This test process's folder, made the first time one is asked for. */
let _testDir = null;

/**
 * Where the records file is.
 * @param {string} [dir]  The folder a test named for bot-config.json.
 * @returns {string}
 */
function positionRecordsPath(dir) {
  if (dir !== undefined && dir !== null) return path.join(dir, RECORDS_FILE);
  if (process.env.NODE_TEST_CONTEXT === undefined)
    return path.join(process.cwd(), "app-data", RECORDS_FILE);
  if (_testDir === null) _testDir = makeTestTempFolder("records");
  return path.join(_testDir, RECORDS_FILE);
}

/** Whether `v` is a plain object. */
const _isGroup = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Every position's records, by position key: `{}` when there is no file,
 * or when it cannot be read as one, which the settings check refuses at
 * startup before anything loads it.
 * @param {string} [dir]  As for `positionRecordsPath`.
 * @returns {Record<string, object>}
 */
function readPositionRecords(dir) {
  let text;
  try {
    text = fs.readFileSync(positionRecordsPath(dir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    const raw = JSON.parse(text);
    return _isGroup(raw?.positions) ? raw.positions : {};
  } catch {
    return {};
  }
}

/**
 * Put each position's records into its slot in `cfg`, making a slot for a
 * position that has records and no settings. A record already in the slot
 * gives way to the records file's.
 * @param {{positions: object}} cfg  Mutated in place.
 * @param {Record<string, object>} records
 */
function mergePositionRecords(cfg, records) {
  for (const [key, rec] of Object.entries(records)) {
    if (!_isGroup(rec)) continue;
    const slot = _isGroup(cfg.positions[key]) ? cfg.positions[key] : {};
    for (const k of RECORD_POSITION_KEYS)
      if (rec[k] !== undefined) slot[k] = rec[k];
    cfg.positions[key] = slot;
  }
}

/**
 * Split slots into what each file holds: the records, and everything
 * else, which is bot-config.json's. A slot left with nothing for a file
 * gets no entry there.
 * @param {Record<string, object>} positions
 * @returns {{settings: Record<string, object>, records: Record<string, object>}}
 */
function splitPositionSlots(positions) {
  const settings = {};
  const records = {};
  for (const [key, slot] of Object.entries(positions)) {
    if (!_isGroup(slot)) continue;
    const s = {};
    const r = {};
    for (const [k, v] of Object.entries(slot))
      (RECORD_POSITION_KEYS.includes(k) ? r : s)[k] = v;
    if (Object.keys(s).length > 0) settings[key] = s;
    if (Object.keys(r).length > 0) records[key] = r;
  }
  return { settings, records };
}

/**
 * Copy the records file beside itself, as `loadConfig` copies
 * bot-config.json: a way back from a save that went wrong.
 * @param {string} [dir]  As for `positionRecordsPath`.
 */
function backUpPositionRecords(dir) {
  const file = positionRecordsPath(dir);
  try {
    fs.copyFileSync(file, file.replace(".json", ".backup.json"));
  } catch {
    /* best-effort, and no file means nothing to keep */
  }
}

/**
 * Write every position's records, atomically: to a file beside it, then
 * renamed over it, so a process stopped mid-write leaves the old file
 * whole.
 * @param {Record<string, object>} records
 * @param {string} [dir]  As for `positionRecordsPath`.
 */
function writePositionRecords(records, dir) {
  const file = positionRecordsPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify({ positions: records }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp cleanup */
    }
    throw err;
  }
}

module.exports = {
  RECORDS_FILE,
  positionRecordsPath,
  readPositionRecords,
  mergePositionRecords,
  splitPositionSlots,
  backUpPositionRecords,
  writePositionRecords,
};
