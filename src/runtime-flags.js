/**
 * @file src/runtime-flags.js
 * @module runtime-flags
 * @description
 * Runtime, environment-derived flags and helpers for LP Ranger. Anything
 * sourced from `process.env`, `process.argv`, or computed by selecting
 * a row out of `chains.json` (loaded via the layered defaults+user-
 * override loader; operators override at
 * `app-config/user-configurable/chains.json`) lives here. Pure tracked
 * data (ports, timeouts, aggregator URL, etc.) lives in
 * `app-config/app-defaults-for-user-configurable/app-runtime.json`,
 * loaded through the same layered loader by `src/config.js` and — for
 * `defaults.chain`, the shipped fallback behind `CHAIN_NAME` — here.
 *
 * `src/config.js` re-exports the flags its callers use, so they keep
 * working; new code can import directly from this module when it only
 * needs runtime flags and wants to avoid pulling in the rest of the
 * config surface.
 */

"use strict";

const dotenv = require("dotenv");
const { loadMergedDefaults } = require("./load-merged-defaults");
const { assertTimerSec } = require("./timer-bounds");
const { boundAt } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");
const { readEnv } = require("./env-settings");
const { serverPort, serverHost } = require("./server-address");

const CHAINS = loadMergedDefaults("chains.json");
const APP_RUNTIME = loadMergedDefaults("app-runtime.json");

/*- Load .env if present; dotenv.config() returns `{ error }` (without
    throwing) when no file exists, so production environments where env
    vars are injected by the platform fall back to process.env as-is. */
dotenv.config();

/**
 * Read a whole number of seconds that becomes a timer delay: the
 * environment variable `envName` when it is set, else `fallbackSec`.
 *
 * The variable is read by its rule in src/env-settings.js, so text that
 * is not a whole number in plain digits stops startup, naming it. The
 * bounds live in `src/timer-bounds.js`, shared with the other road to
 * the same settings, the JSON files an operator can override. Separate
 * copies of the rule are how they once came to disagree.
 *
 * Out of range throws, so the app stops at startup naming the setting,
 * rather than running on a schedule its operator did not choose. A bad
 * fallback is held to the rule too, which is not hypothetical:
 * `TX_CANCEL_SEC` defaults to `deadlineSec x cancelToDeadlineMultiple`,
 * both operator-editable.
 *
 * @param {string} envName      Name as `.env` spells it.
 * @param {number} fallbackSec  The JSON value it overrides; also sets a
 *   ceiling.
 * @param {string} key          Canonical name, for the bounds table.
 * @param {object} [env]        The environment; `process.env` unless a
 *   test reads another.
 * @returns {number} Seconds, within range.
 * @throws {Error} When the value is unusable as a delay.
 */
function parseTimerSec(envName, fallbackSec, key, env = process.env) {
  const sec = readEnv(envName, env) ?? fallbackSec;
  try {
    return assertTimerSec({
      sec,
      key,
      defaultSec: fallbackSec,
      label: envName,
      remedy:
        `Set ${envName} in .env within range, or correct the ` +
        `app-runtime.json values it defaults from, and restart.`,
    });
  } catch (err) {
    /*- Re-thrown only to carry the `[config]` tag the rest of this
     *  file's startup errors use; the sentence is already the right
     *  one. */
    throw new Error(`[config] ${err.message}`, { cause: err });
  }
}

/**
 * Read a setting from `.env`, held to its range in setting-bounds.json:
 * a Bot Setting, or the transaction deadline.
 *
 * The range is the one a save from the dashboard is held to and the one
 * the defaults files are read against, so a setting has one range
 * whichever road it comes by. A variable left unset, or set to nothing,
 * leaves `fallback` standing: the value the defaults files give. A set
 * one is read by its rule in src/env-settings.js and must be inside the
 * range, or startup stops and names the variable and the range, as it
 * does for a timer setting. A value quietly replaced, rounded or cut
 * short would leave the bot on a setting nobody chose.
 *
 * @param {string} envName   The variable's name.
 * @param {number} fallback  The value when the variable is unset.
 * @param {string} key       The setting's path in setting-bounds.json,
 *   such as `maxRebalancesPerDay` or `tx.deadlineSec`.
 * @param {object} [env]     The environment; `process.env` unless a test
 *   reads another.
 * @returns {number} The value, inside its range.
 * @throws {Error} When the variable is set to anything else, so the app
 *   does not start on a value its range refuses.
 */
function parseBoundedSetting(envName, fallback, key, env = process.env) {
  const value = readEnv(envName, env);
  if (value === undefined) return fallback;
  const bound = boundAt(key);
  if (withinBound(value, bound)) return value;
  throw new Error(
    `[config] ${envName} in .env must be ${boundText(bound)}; it is ` +
      `${_show(env[envName])}. Correct it there, or remove it to use the ` +
      "default, and restart.",
  );
}

/*- Render a value for an error message. `process.env` only ever yields
 *  strings, so anything else reaching these functions came from a
 *  hand-edited app-runtime.json: a number, null, NaN, an object. */
function _show(value) {
  if (value === undefined) return "unset";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

/*- A usable chain name is a non-empty string once trimmed. Everything
 *  else — empty, whitespace, undefined, NaN, a number — is not a name. */
function _cleanName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Resolve which chain to run against, from the JSON default and the
 * environment override.
 *
 * `defaults.chain` in `app-runtime.json` is where the name is configured.
 * `CHAIN_NAME` in `.env` overrides it, for headless installs that have no
 * dashboard to configure. Neither yielding a usable name throws, rather
 * than picking one — there is no safe guess about which blockchain an
 * operator meant to put funds on.
 *
 * Each source counts only when it yields a usable name — a non-empty
 * string once trimmed. An unset, blank or malformed `CHAIN_NAME` is
 * therefore no override at all, and the JSON default still applies,
 * rather than a stray `.env` line defeating it.
 *
 * The throw is on the RESOLVED value: when neither source yields a
 * usable name, nothing is picked, because there is no safe guess about
 * which blockchain an operator meant to put funds on.
 *
 * @param {*} envValue       Raw `process.env.CHAIN_NAME`.
 * @param {*} shippedDefault `app-runtime.json` → `defaults.chain`.
 * @returns {string} A trimmed, lowercased chain name.
 * @throws {Error} When neither source yields a non-empty string.
 */
function resolveChainName(envValue, shippedDefault) {
  const resolved = _cleanName(envValue) || _cleanName(shippedDefault);
  if (resolved) return resolved;
  throw new Error(
    "No chain name is configured. Set `defaults.chain` to a chain name in " +
      "app-config/user-configurable/app-runtime.json — it must match an " +
      "entry in chains.json. (The shipped copy under " +
      "app-config/app-defaults-for-user-configurable/ is overwritten by " +
      "every upgrade, so edit the user-configurable one.) CHAIN_NAME in " +
      ".env overrides it, for headless installs. " +
      `Got defaults.chain=${_show(shippedDefault)}, ` +
      `CHAIN_NAME=${_show(envValue)}.`,
  );
}

/**
 * Look up a chain's configuration row by name.
 *
 * A name matching no entry throws. There is nothing to fall back TO: the
 * entry carries the RPC endpoints and the contract addresses every
 * transaction is built against, so substituting another chain's entry
 * would send real transactions to a chain the operator did not ask for.
 * The name itself is unaffected by any such substitution, and it is what
 * gets stamped into composite position keys, cache filenames and
 * notifications — so the mismatch would not be visible in anything the
 * run recorded.
 *
 * @param {Record<string, object>} chains Parsed chains.json, keyed by chain name.
 * @param {string} name                   Chain name from `resolveChainName`.
 * @returns {object} That chain's configuration entry.
 * @throws {Error} When `name` matches no entry in `chains`.
 */
function selectChain(chains, name) {
  const clean = _cleanName(name);
  const row = clean && chains && chains[clean];
  if (row) return row;
  const known =
    Object.keys(chains || {})
      .sort()
      .join(", ") || "(none)";
  const setIt =
    `Configured chains: ${known}. Set \`defaults.chain\` to one of those ` +
    "in app-config/user-configurable/app-runtime.json";
  if (!clean) {
    throw new Error(
      `${_show(name)} is not a usable chain name. ${setIt}. ` +
        "CHAIN_NAME in .env overrides it, and takes the same values.",
    );
  }
  throw new Error(
    `No blockchain configuration found for chain name ${_show(name)}. ` +
      `${setIt}, or add an entry named ${_show(name)} to ` +
      "app-config/user-configurable/chains.json. CHAIN_NAME in .env " +
      "overrides both, and takes the same values.",
  );
}

/**
 * Active chain name. Set CHAIN_NAME=pulsechain-testnet for testnet.
 * The shipped default is `app-runtime.json` → `defaults.chain`, which is
 * the only place that name is written down.
 */
const CHAIN_NAME = resolveChainName(
  process.env.CHAIN_NAME,
  APP_RUNTIME.defaults.chain,
);

/** Active chain config (aggregator tunables, chainId, contracts, etc.). */
const CHAIN = selectChain(CHAINS, CHAIN_NAME);

/** Map human-readable names to EIP-2718 transaction envelope type numbers. */
const TX_ENVELOPE_TYPES = { legacy: 0, eip1559: 2 };

/**
 * Turn the active chain's `transactionEnvelopeType` into the EIP-2718
 * type number every send is stamped with.
 *
 * A name this app does not know stops startup, naming the setting. The
 * alternative, sending legacy transactions in its place, would hide a
 * typo behind transactions that still go out, and on a chain whose
 * validators favour one envelope a misnamed type is how transactions
 * come to sit pending.
 *
 * @param {string} chainName  The active chain, for the message.
 * @param {*} name            The configured name.
 * @returns {number} The envelope type number.
 * @throws {Error} When the name is not one of `TX_ENVELOPE_TYPES`.
 */
function resolveTxType(chainName, name) {
  if (Object.hasOwn(TX_ENVELOPE_TYPES, name)) return TX_ENVELOPE_TYPES[name];
  throw new Error(
    `[config] chains.json → ${chainName}.transactionEnvelopeType must be ` +
      `one of ${Object.keys(TX_ENVELOPE_TYPES).join(", ")}; ` +
      `it is ${JSON.stringify(name)}.`,
  );
}

/** Resolved EIP-2718 envelope type number for the active chain. */
const TX_TYPE = resolveTxType(CHAIN_NAME, CHAIN.transactionEnvelopeType);

/** Raw hex private key for the signing wallet (alternative to the encrypted
 *  app-config/user-configurable/wallet.json). */
const PRIVATE_KEY = readEnv("PRIVATE_KEY") ?? null;

/** Dry-run mode — read-only, no transactions. Set DRY_RUN=true to enable. */
const DRY_RUN = readEnv("DRY_RUN") === true;

/** Verbose logging (--verbose or -v on the command line, or VERBOSE=true env). */
const VERBOSE =
  readEnv("VERBOSE") === true ||
  process.argv.includes("--verbose") ||
  process.argv.includes("-v");

/*-
 *  Where the dashboard server listens, asked at startup so a wrong PORT
 *  or HOST stops it here. src/server-address.js reads both, the one way
 *  the stop scripts read them too.
 */
const PORT = serverPort();
const HOST = serverHost();

module.exports = {
  parseTimerSec,
  parseBoundedSetting,
  resolveChainName,
  selectChain,
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,
  PRIVATE_KEY,
  DRY_RUN,
  VERBOSE,
  PORT,
  HOST,
};
