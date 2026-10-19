"use strict";

/**
 * @file src/bot-config-checks.js
 * @module bot-config-checks
 * @description
 * Every problem with bot-config.json, the Bot Settings saved from the
 * dashboard for each position and the settings of its global section,
 * and with the records file, `app-data/position-records.json`, where the
 * bot keeps its records for each position (src/position-records.js).
 *
 * bot-config.json is held to a JSON Schema built here from the schema of
 * each setting in it, the one a save is held to (`settingSchemas`,
 * src/config-bounds.js), so what a save would refuse stops startup too.
 * The two values the app writes for itself have schemas of their own: a
 * position's status, and the Telegram alerts chosen (`ALERT_CHOICES`,
 * which the Telegram route holds a save to). Each group names every key
 * it takes and refuses any other. A key LP Ranger has retired
 * (src/bot-config-keys.js) is left for the next save to drop, and a
 * record, which releases before the records file kept here, is refused
 * with the command that moves it. A value of `null` is a setting
 * cleared, and the default stands.
 *
 * The records file holds each record to the shape the bot writes
 * (src/config-record-checks.js).
 *
 * Used by the settings check (src/settings-check.js).
 */

const { settingSchemas } = require("./config-bounds");
const { RECORD_CHECKS } = require("./config-record-checks");
const {
  GLOBAL_KEYS,
  SETTING_POSITION_KEYS,
  RECORD_POSITION_KEYS,
  RETIRED_GLOBAL_KEYS,
  RETIRED_POSITION_KEYS,
} = require("./bot-config-keys");
const { parseCompositeKey } = require("./composite-key");
const { AJV, KINDS } = require("./value-kinds");
const { problemsFromErrors } = require("./settings-schema-parts");
const { ALERT_CHOICES } = require("./telegram-notifications/telegram-events");

const _FILE = "bot-config.json";
const _RECORDS_FILE = "app-data/position-records.json";

/** Whether `v` is a group of settings: a plain object. */
const _isGroup = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/*- A position's status: whether the next launch starts it. */
const _STATUS = Object.freeze({
  type: "string",
  enum: ["running", "stopped"],
  description: "running or stopped",
});

/*-
 *  A record in bot-config.json, where releases before the records file
 *  kept every record. Its schema refuses any value, and says where the
 *  record belongs.
 */
const _MISPLACED = Object.freeze({
  not: {},
  description:
    `is a record, which LP Ranger now keeps in ${_RECORDS_FILE}; ` +
    "`node ./util/migration` moves it there",
});

/** A setting's schema, taking null too: a setting cleared. */
function _orCleared(schema) {
  return {
    ...schema,
    type: [schema.type, "null"],
    ...(schema.enum === undefined ? {} : { enum: [...schema.enum, null] }),
  };
}

/** Each key's schema of those given, from the schemas by key. */
function _pick(schemas, keys) {
  return Object.fromEntries(
    keys.map((k) => {
      if (schemas[k] === undefined)
        throw new Error(
          `${k} is saved, but src/config-bounds.js has no schema for it`,
        );
      return [k, schemas[k]];
    }),
  );
}

/**
 * A group of settings: the settings it takes, any records misplaced in
 * it, and the keys it has retired, and no other key.
 *
 * @param {Object<string, object>} settings  Each setting's schema.
 * @param {string[]} misplaced  Records that belong in the records file.
 * @param {string[]} retired  Keys left for the next save to drop.
 * @returns {object}
 */
function _group(settings, misplaced, retired) {
  return {
    type: "object",
    description: "a group of settings",
    properties: {
      ...Object.fromEntries(
        Object.entries(settings).map(([k, s]) => [k, _orCleared(s)]),
      ),
      ...Object.fromEntries(misplaced.map((k) => [k, _MISPLACED])),
      ...Object.fromEntries(retired.map((k) => [k, true])),
    },
    additionalProperties: false,
  };
}

/**
 * bot-config.json's schema.
 *
 * @param {object} ctx  As for `botConfigProblems`.
 * @returns {object}
 */
function _schema(ctx) {
  const settings = settingSchemas(ctx);
  return {
    type: "object",
    description: "a group of settings",
    properties: {
      global: _group(
        { ..._pick(settings, GLOBAL_KEYS), telegramEvents: ALERT_CHOICES },
        [],
        RETIRED_GLOBAL_KEYS,
      ),
      positions: {
        type: "object",
        description: "a group of positions",
        propertyNames: KINDS.positionKey.schema,
        additionalProperties: _group(
          { ..._pick(settings, SETTING_POSITION_KEYS), status: _STATUS },
          RECORD_POSITION_KEYS,
          RETIRED_POSITION_KEYS,
        ),
      },
    },
    additionalProperties: false,
  };
}

/*-
 *  bot-config.json's schema compiled, for each fee floor a caller has
 *  passed. Startup passes one, so it is compiled once.
 */
const _compiled = new Map();

/**
 * Every problem with bot-config.json.
 *
 * @param {string} text  The file.
 * @param {object} ctx   What a rule needs from the other settings:
 *   `compoundMinFeeUsd`, the floor of the auto-compound threshold, from
 *   app-runtime.json.
 * @returns {string[]}
 */
function botConfigProblems(text, ctx) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return [`${_FILE} is not valid JSON: ${err.message}`];
  }
  const floor = ctx.compoundMinFeeUsd;
  if (!_compiled.has(floor)) _compiled.set(floor, AJV.compile(_schema(ctx)));
  const validate = _compiled.get(floor);
  return validate(cfg) ? [] : problemsFromErrors(_FILE, validate.errors);
}

/** Every problem with one position's records. */
function _recordProblems(where, slot) {
  const problems = [];
  for (const [key, value] of Object.entries(slot)) {
    if (!RECORD_POSITION_KEYS.includes(key))
      problems.push(`${where}.${key} is not a record LP Ranger keeps`);
    else if (value !== null) {
      const problem = RECORD_CHECKS[key](value, key);
      if (problem !== null) problems.push(`${where}.${key}: ${problem}`);
    }
  }
  return problems;
}

/**
 * Every problem with the records file, `app-data/position-records.json`:
 * `{ "positions": { "<position key>": { <records> } } }`, each record held
 * to the shape the bot writes.
 *
 * @param {string} text  The file.
 * @returns {string[]}
 */
function positionRecordsProblems(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch (err) {
    return [`${_RECORDS_FILE} is not valid JSON: ${err.message}`];
  }
  if (!_isGroup(file)) return [`${_RECORDS_FILE} must be a group of records`];
  const problems = [];
  for (const key of Object.keys(file))
    if (key !== "positions")
      problems.push(`${_RECORDS_FILE} → ${key} is not part of the file`);
  if (file.positions === undefined) return problems;
  if (!_isGroup(file.positions))
    return [...problems, `${_RECORDS_FILE} → positions must be a group`];
  for (const [key, slot] of Object.entries(file.positions)) {
    const where = `${_RECORDS_FILE} → positions.${key}`;
    if (parseCompositeKey(key) === null)
      problems.push(
        `${where} is not a position's key, which is chain-wallet-contract-NFT`,
      );
    else if (!_isGroup(slot)) problems.push(`${where} must be a group`);
    else problems.push(..._recordProblems(where, slot));
  }
  return problems;
}

module.exports = { botConfigProblems, positionRecordsProblems };
