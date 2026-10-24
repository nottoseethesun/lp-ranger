"use strict";

/**
 * @file src/lib/env-settings.js
 * @module env-settings
 * @description
 * Every environment variable LP Ranger reads, what each may be, and how
 * its text is read.
 *
 * `.env` holds text. Each rule here both checks a variable and reads it,
 * so a value is read one way and refused one way: an on/off variable is
 * `true` or `false`, a number is written in plain decimal digits, an
 * address is EIP-55, and nothing is coerced. `readEnv` answers the value
 * a variable sets, or undefined when it sets none, and throws naming the
 * variable when its text is anything else; the app's readers read
 * through it (src/lib/runtime-flags.js, src/lib/config.js). `envProblems` asks
 * every variable at once, its range or timer rule included, and
 * `envFileProblems` finds a line in `.env` that sets nothing LP Ranger
 * reads, both for the settings check (src/lib/settings-check.js) at startup
 * and in the `validate-config-values-with-any-user-overrides` diagnostic.
 *
 * A variable unset, or set to nothing but spaces, sets no value: the
 * JSON setting it overrides, or the default, stands.
 *
 * The private key and the wallet password are never quoted back.
 */

const validator = require("validator");
const { boundAt } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");
const { assertTimerSec } = require("./timer-bounds");
const { isUrl, isAddress } = require("./value-kinds");

/** A kind of `.env` value: the words for what passes, and its reading. */
const _kind = (what, read) => Object.freeze({ what, read });

/*-
 *  Each kind's `read` answers the value its text sets, or undefined when
 *  the text is not one. Only TEXT keeps the text as written; the rest are
 *  read with surrounding spaces removed.
 */
const TEXT = _kind("text", (t) => t);
const ON_OFF = _kind("true or false", (t) => {
  if (t === "true") return true;
  return t === "false" ? false : undefined;
});
const WHOLE = _kind("a whole number of at least 1, in plain digits", (t) =>
  /^\d+$/.test(t) && Number(t) >= 1 ? Number(t) : undefined,
);
// An NFT's number, kept as the text it is, which may exceed a number's.
const NFT_ID = _kind("an NFT's number, in plain digits", (t) =>
  /^\d+$/.test(t) ? t : undefined,
);
/*-
 *  Digits, points and a leading minus only, so an exponent, a hex prefix
 *  or a comma is refused rather than read; a malformed number such as
 *  "1.2.3" is not a finite number either.
 */
const DECIMAL = _kind("a plain decimal number", (t) => {
  const n = /^-?[\d.]+$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) ? n : undefined;
});
const PORT_NUMBER = _kind(
  "a port number from 1 to 65535, in plain digits",
  (t) => {
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    return n >= 1 && n <= 65535 ? n : undefined;
  },
);
const HOST_NAME = _kind("a host name or an IP address", (t) =>
  validator.isIP(t) || validator.isFQDN(t, { require_tld: false })
    ? t
    : undefined,
);
const HTTP_URL = _kind("an http or https address", (t) =>
  isUrl(t) ? t : undefined,
);
const ADDRESS = _kind("an EIP-55 address", (t) =>
  isAddress(t) ? t : undefined,
);
/*-
 *  A private key as the wallet takes it: 64 hexadecimal digits, after a
 *  0x or without one, since ethers adds the prefix when it is missing.
 */
const KEY = _kind("64 hexadecimal digits, after a 0x or without one", (t) =>
  /^(0x)?[0-9a-fA-F]{64}$/.test(t) ? t : undefined,
);
/*-
 *  Named as chains.json names it, in either letter case. Judged with the
 *  chains.json in force, which `envProblems` has; the app resolves the
 *  name itself (`resolveChainName`, src/lib/runtime-flags.js), which refuses
 *  a name no entry holds.
 */
const CHAIN = _kind("the name of a chain in chains.json", (t, ctx) => {
  const name = t.toLowerCase();
  return ctx !== undefined && Object.hasOwn(ctx.chains, name)
    ? name
    : undefined;
});

/** The deadline TX_CANCEL_SEC multiplies, as config.js resolves it. */
function _deadlineSec(ctx, env) {
  const fromEnv = WHOLE.read(String(env.DEADLINE_SEC ?? "").trim());
  return fromEnv ?? ctx.appRuntime?.tx?.deadlineSec;
}

/*-
 *  Every variable LP Ranger reads, by name. A setting with a range is
 *  held to it (`range`, its path in setting-bounds.json), and a setting
 *  that becomes a timer delay to the timer rule (`timer`), whose ceiling
 *  is a multiple of the JSON value the variable overrides (`defaultOf`).
 */
const ENV_SETTINGS = Object.freeze({
  CHAIN_NAME: { kind: CHAIN },
  PORT: { kind: PORT_NUMBER },
  HOST: { kind: HOST_NAME },
  PRIVATE_KEY: { kind: KEY, secret: true },
  WALLET_PASSWORD: { kind: TEXT, secret: true },
  DRY_RUN: { kind: ON_OFF },
  VERBOSE: { kind: ON_OFF },
  RPC_URL: { kind: HTTP_URL },
  RPC_URL_FALLBACK: { kind: HTTP_URL },
  RPC_URL_FALLBACK_2: { kind: HTTP_URL },
  AGGREGATOR_URL: { kind: HTTP_URL },
  POSITION_ID: { kind: NFT_ID },
  POSITION_MANAGER: { kind: ADDRESS },
  FACTORY: { kind: ADDRESS },
  SWAP_ROUTER: { kind: ADDRESS },
  REBALANCE_OOR_THRESHOLD_PCT: {
    kind: DECIMAL,
    range: "rebalanceOutOfRangeThresholdPercent",
  },
  REBALANCE_TIMEOUT_MIN: { kind: DECIMAL, range: "rebalanceTimeoutMin" },
  MIN_REBALANCE_INTERVAL_MIN: {
    kind: DECIMAL,
    range: "minRebalanceIntervalMin",
  },
  MAX_REBALANCES_PER_DAY: { kind: DECIMAL, range: "maxRebalancesPerDay" },
  IMPERMANENT_LOSS_GUARD_PCT: {
    kind: DECIMAL,
    range: "impermanentLossGuardPct",
  },
  TX_SPEEDUP_SEC: {
    kind: WHOLE,
    timer: "txSpeedupSec",
    defaultOf: (ctx) => ctx.appRuntime?.tx?.speedupSec,
  },
  TX_CANCEL_SEC: {
    kind: WHOLE,
    timer: "txCancelSec",
    defaultOf: (ctx, env) =>
      _deadlineSec(ctx, env) * ctx.appRuntime?.tx?.cancelToDeadlineMultiple,
  },
  CHECK_INTERVAL_SEC: {
    kind: WHOLE,
    timer: "checkIntervalSec",
    defaultOf: (ctx) => ctx.botDefaults?.checkIntervalSec,
  },
  DEADLINE_SEC: { kind: WHOLE, range: "tx.deadlineSec" },
  LOG_FILE: { kind: TEXT },
  /*-
   *  Read by LP Ranger's own tools rather than by the server or the bot:
   *  the inspector port `npm run debug-attach` connects to and the
   *  process it attaches to (scripts/_debug-attach.js), and the Moralis
   *  key the verify-compound-usd diagnostic prices with. A process id
   *  changes with every start, so LP_RANGER_PID suits the command line
   *  better than `.env`.
   */
  INSPECTOR_PORT: { kind: PORT_NUMBER },
  LP_RANGER_PID: { kind: WHOLE },
  MORALIS_API_KEY: { kind: TEXT, secret: true },
  /*-
   *  Where the tests point a file the app keeps; nothing that ships sets
   *  them, and an operator has no reason to.
   */
  LP_RANGER_USER_CONFIG_DIR: { kind: TEXT },
  LP_RANGER_DEFAULTS_DIR: { kind: TEXT },
  WALLET_FILE_PATH: { kind: TEXT },
  API_KEYS_FILE_PATH: { kind: TEXT },
  GECKO_POOL_CACHE_PATH: { kind: TEXT },
  TOKEN_SYMBOL_CACHE_PATH: { kind: TEXT },
  PRICE_CACHE_PATH: { kind: TEXT },
  POOL_CREATION_BLOCK_CACHE_PATH: { kind: TEXT },
  LIQUIDITY_PAIR_DETAILS_CACHE_PATH: { kind: TEXT },
  BLOCK_TIME_CACHE_PATH: { kind: TEXT },
});

/** The text a setting's kind reads: as written for TEXT, else trimmed. */
function _textOf(setting, raw) {
  return setting.kind === TEXT ? raw : raw.trim();
}

/** Whether a variable sets anything: unset or blank sets nothing. */
const _isSet = (raw) => typeof raw === "string" && raw.trim() !== "";

/**
 * Words for a variable whose text is not what it must be: its range, for
 * a Bot Setting, which says more than its kind does.
 */
function _refusal(name, setting, raw) {
  const what =
    setting.range === undefined
      ? setting.kind.what
      : boundText(boundAt(setting.range));
  const shown =
    setting.secret === true ? "its value is not shown" : `it is "${raw}"`;
  return `${name} in .env must be ${what}; ${shown}`;
}

/**
 * The value an environment variable sets, read by its rule.
 *
 * @param {string} name  A variable `ENV_SETTINGS` names.
 * @param {object} [env]  The environment; `process.env` unless a caller
 *   reads another.
 * @returns {*} The value, or undefined when the variable sets none.
 * @throws {Error} When its text is not what the variable must be, naming
 *   the variable, so the app does not run on a value it would have
 *   guessed at.
 */
function readEnv(name, env = process.env) {
  const raw = env[name];
  if (!_isSet(raw)) return undefined;
  const setting = ENV_SETTINGS[name];
  const value = setting.kind.read(_textOf(setting, raw));
  if (value === undefined)
    throw new Error(`[config] ${_refusal(name, setting, raw)}.`);
  return value;
}

/** A set variable's range or timer problem, or null. */
function _boundProblem(name, setting, value, raw, ctx, env) {
  if (setting.range !== undefined) {
    const bound = boundAt(setting.range);
    return withinBound(value, bound)
      ? null
      : `${name} in .env must be ${boundText(bound)}; it is "${raw}"`;
  }
  if (setting.timer === undefined) return null;
  try {
    assertTimerSec({
      sec: value,
      key: setting.timer,
      defaultSec: setting.defaultOf(ctx, env),
      label: `${name} in .env`,
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Every problem with the environment variables LP Ranger reads: text that
 * is not what a variable must be, and a value outside its range or timer
 * rule. Variables it does not read are not looked at here; see
 * `envFileProblems`.
 *
 * @param {object} env  The environment, `.env` loaded into it.
 * @param {object} ctx  The settings the variables are judged against:
 *   `chains` (chains.json), `appRuntime` (app-runtime.json) and
 *   `botDefaults` (bot-config-defaults.json), an install's copies
 *   included.
 * @returns {string[]}
 */
function envProblems(env, ctx) {
  const problems = [];
  for (const [name, setting] of Object.entries(ENV_SETTINGS)) {
    const raw = env[name];
    if (!_isSet(raw)) continue;
    const value = setting.kind.read(_textOf(setting, raw), ctx);
    if (value === undefined) {
      problems.push(_refusal(name, setting, raw));
      continue;
    }
    const problem = _boundProblem(name, setting, value, raw, ctx, env);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

/**
 * The lines of a `.env` file that set something: each line's number, and
 * the name it sets, or null for a line that is not `NAME=value`. Blank
 * lines and comments set nothing, and neither do the further lines of a
 * quoted value that runs over several.
 *
 * @param {string} text  The file.
 * @returns {{line: number, name: string|null}[]}
 */
function _settingLines(text) {
  const out = [];
  let open = null; // the quote a value running over lines opened with
  text.split(/\r?\n/).forEach((line, i) => {
    if (open !== null) {
      if (line.includes(open)) open = null;
      return;
    }
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return;
    // `export NAME=value` sets NAME, as dotenv reads it.
    const bare = /^export\s/.test(t) ? t.slice("export".length).trimStart() : t;
    const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(bare);
    if (m === null) {
      out.push({ line: i + 1, name: null });
      return;
    }
    out.push({ line: i + 1, name: m[1] });
    const q = m[2][0];
    if ((q === '"' || q === "'" || q === "`") && m[2].indexOf(q, 1) === -1)
      open = q;
  });
  return out;
}

/**
 * Every line of a `.env` file that sets nothing LP Ranger reads: one
 * naming a variable it does not read, or one that is not `NAME=value`.
 *
 * @param {string} text  The file.
 * @returns {string[]}
 */
function envFileProblems(text) {
  const problems = [];
  for (const { line, name } of _settingLines(text)) {
    if (name === null)
      problems.push(
        `.env → line ${line} is not a setting, which is NAME=value`,
      );
    else if (!Object.hasOwn(ENV_SETTINGS, name))
      problems.push(`.env → ${name} is not a setting LP Ranger reads`);
  }
  return problems;
}

module.exports = { ENV_SETTINGS, readEnv, envProblems, envFileProblems };
