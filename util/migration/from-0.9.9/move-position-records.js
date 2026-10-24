"use strict";

/**
 * @file util/migration/from-0.9.9/move-position-records.js
 * @description
 * A migration step: move each position's records out of bot-config.json,
 * where releases before the records file kept them beside the settings,
 * into `app-data/position-records.json` (src/position-records.js). A
 * record is what the bot worked out or logged about a position, such as
 * its HODL baseline or compound history (`RECORD_POSITION_KEYS`); what is
 * left in bot-config.json is the operator's settings and each position's
 * status.
 *
 * A record already in the records file was written by this release and
 * is kept. Before anything is written, bot-config.json is copied into
 * `tmp/`, so the move can be undone even on an install updated in place.
 * The records file is written before bot-config.json, so a run stopped
 * between the two leaves every record in at least one of them.
 *
 * Runs on Node built-ins only, like the rest of the migration.
 */

const fs = require("fs");
const path = require("path");
const { RECORD_POSITION_KEYS } = require("../../../src/bot-config-keys");

/** Whether `v` is a plain object. */
const _isGroup = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Read a JSON file, or null when there is none. */
function _readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text);
}

/** Write a JSON file atomically. */
function _writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
}

/**
 * Take every record out of the slots in `cfg`, into `records`, keeping
 * any `records` already holds.
 * @returns {number}  How many values moved.
 */
function _takeRecords(cfg, records) {
  let moved = 0;
  for (const [key, slot] of Object.entries(cfg.positions)) {
    if (!_isGroup(slot)) continue;
    for (const k of RECORD_POSITION_KEYS) {
      if (!(k in slot)) continue;
      if (!_isGroup(records[key])) records[key] = {};
      if (records[key][k] === undefined) records[key][k] = slot[k];
      delete slot[k];
      moved++;
    }
  }
  return moved;
}

/**
 * Move the records in the install's bot-config.json into the records
 * file.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would move, and move nothing.
 * @returns {string[]}  One line for what moved, or none.
 */
function movePositionRecords({ root, dryRun }) {
  const configFile = path.join(
    root,
    "app-config",
    "user-configurable",
    "bot-config.json",
  );
  const recordsFile = path.join(root, "app-data", "position-records.json");
  let cfg;
  try {
    cfg = _readJson(configFile);
  } catch (err) {
    return [
      `app-config/user-configurable/bot-config.json is not valid JSON (${err.message}); left as it was`,
    ];
  }
  if (cfg === null || !_isGroup(cfg.positions)) return [];
  const existing = _readJson(recordsFile);
  const records = _isGroup(existing?.positions) ? existing.positions : {};
  const moved = _takeRecords(cfg, records);
  if (moved === 0) return [];
  const verb = dryRun ? "would move" : "moved";
  const line = `${verb} ${moved} record value(s) from app-config/user-configurable/bot-config.json to app-data/position-records.json`;
  if (dryRun) return [line];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = path.join(root, "tmp", `bot-config.pre-migration-${stamp}.json`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(configFile, copy);
  _writeJson(recordsFile, { positions: records });
  _writeJson(configFile, cfg);
  return [
    line,
    `kept a copy of the old bot-config.json at tmp/${path.basename(copy)}`,
  ];
}

module.exports = { movePositionRecords };
