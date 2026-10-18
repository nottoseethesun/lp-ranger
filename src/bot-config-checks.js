"use strict";

/**
 * @file src/bot-config-checks.js
 * @module bot-config-checks
 * @description
 * Every problem with bot-config.json: the Bot Settings saved from the
 * dashboard for each position, the records the bot keeps beside them,
 * and the settings of its global section.
 *
 * A value is held to the rule `POST /api/config` holds it to when it is
 * saved (src/config-bounds.js, which takes the records' shapes from
 * src/config-record-checks.js), so what a save would refuse is refused
 * here too. The two values the app writes for itself, a position's
 * status and the Telegram alerts chosen, have rules of their own here. A
 * key LP Ranger does not read is reported; one it has retired
 * (src/bot-config-keys.js) is left for the next save to drop. A value of
 * `null` is a setting cleared, and the default stands.
 *
 * Used by the settings check (src/settings-check.js).
 */

const { RULES } = require("./config-bounds");
const {
  GLOBAL_KEYS,
  POSITION_KEYS,
  RETIRED_GLOBAL_KEYS,
  RETIRED_POSITION_KEYS,
} = require("./bot-config-keys");
const { parseCompositeKey } = require("./composite-key");
const { EVENT_DEFAULTS } = require("./telegram-notifications/telegram-events");

const _FILE = "bot-config.json";

/** Whether `v` is a group of settings: a plain object. */
const _isGroup = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/*- The alerts an operator chose to be sent, each by name. */
function _telegramEvents(value) {
  if (!_isGroup(value)) return "must be the alerts chosen, each true or false";
  for (const [id, on] of Object.entries(value)) {
    if (!Object.hasOwn(EVENT_DEFAULTS, id))
      return `names ${JSON.stringify(id)}, which is not an alert LP Ranger sends`;
    if (typeof on !== "boolean")
      return `${id} must be true or false; it is ${JSON.stringify(on)}`;
  }
  return null;
}

/*- Whether the bot manages the position. */
function _status(value) {
  return value === "running" || value === "stopped"
    ? null
    : `must be running or stopped; it is ${JSON.stringify(value)}`;
}

/*-
 *  The keys each section holds, and the rule each value is held to: the
 *  one a save is held to, and the app's own for the two it writes
 *  itself.
 */
const _GLOBAL = Object.freeze({
  known: [...GLOBAL_KEYS, "telegramEvents"],
  retired: RETIRED_GLOBAL_KEYS,
  own: { telegramEvents: _telegramEvents },
});
const _POSITION = Object.freeze({
  known: [...POSITION_KEYS, "status"],
  retired: RETIRED_POSITION_KEYS,
  own: { status: _status },
});

/** The problem with one saved value, or null. */
function _valueProblem(section, key, value, ctx) {
  const own = section.own[key];
  if (own !== undefined) return own(value);
  return RULES[key](value, key, ctx);
}

/** Every problem with one section's values. */
function _sectionProblems(where, values, section, ctx) {
  const problems = [];
  for (const [key, value] of Object.entries(values)) {
    if (section.retired.includes(key)) continue;
    if (!section.known.includes(key)) {
      problems.push(`${where}.${key} is not a setting LP Ranger reads`);
      continue;
    }
    if (value === null) continue;
    const problem = _valueProblem(section, key, value, ctx);
    if (problem !== null) problems.push(`${where}.${key}: ${problem}`);
  }
  return problems;
}

/** Every problem with the positions section, slot by slot. */
function _positionsProblems(positions, ctx) {
  const problems = [];
  for (const [key, slot] of Object.entries(positions)) {
    const where = `${_FILE} → positions.${key}`;
    if (parseCompositeKey(key) === null)
      problems.push(
        `${where} is not a position's key, which is chain-wallet-contract-NFT`,
      );
    else if (!_isGroup(slot))
      problems.push(`${where} must be a group of settings`);
    else problems.push(..._sectionProblems(where, slot, _POSITION, ctx));
  }
  return problems;
}

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
  if (!_isGroup(cfg)) return [`${_FILE} must be a group of settings`];
  const problems = [];
  for (const key of Object.keys(cfg))
    if (key !== "global" && key !== "positions")
      problems.push(`${_FILE} → ${key} is not a setting LP Ranger reads`);
  if (cfg.global !== undefined) {
    if (_isGroup(cfg.global))
      problems.push(
        ..._sectionProblems(`${_FILE} → global`, cfg.global, _GLOBAL, ctx),
      );
    else problems.push(`${_FILE} → global must be a group of settings`);
  }
  if (cfg.positions !== undefined) {
    if (_isGroup(cfg.positions))
      problems.push(..._positionsProblems(cfg.positions, ctx));
    else problems.push(`${_FILE} → positions must be a group of positions`);
  }
  return problems;
}

/** Every key bot-config.json may hold, by section, for the tests. */
const BOT_CONFIG_KEYS = Object.freeze({
  global: _GLOBAL.known,
  position: _POSITION.known,
});

module.exports = { botConfigProblems, BOT_CONFIG_KEYS };
