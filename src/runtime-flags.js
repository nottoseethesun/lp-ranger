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
 * `src/config.js` re-exports everything here so existing callers keep
 * working — new code can import directly from this module when it only
 * needs runtime flags and wants to avoid pulling in the rest of the
 * config surface.
 */

"use strict";

const dotenv = require("dotenv");
const { loadMergedDefaults } = require("./load-merged-defaults");
const { assertTimerSec } = require("./timer-bounds");

const CHAINS = loadMergedDefaults("chains.json");
const APP_RUNTIME = loadMergedDefaults("app-runtime.json");

/*- Load .env if present; dotenv.config() returns `{ error }` (without
    throwing) when no file exists, so production environments where env
    vars are injected by the platform fall back to process.env as-is. */
dotenv.config();

/**
 * Parse a positive integer from a string, returning `fallback` on failure.
 * @param {string|undefined} value
 * @param {number}           fallback
 * @returns {number}
 */
function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse a positive integer of seconds that becomes a timer delay.
 *
 * The bounds live in `src/timer-bounds.js`, shared with the two other
 * roads to the same settings — the shipped-defaults JSON and
 * `POST /api/config`. Three copies of the rule is how they came to
 * disagree.
 *
 * Out of range throws, so the app stops at startup naming the setting,
 * rather than running on a schedule its operator did not choose.
 *
 * @param {string|undefined} value  Raw environment override, if any.
 * @param {number} fallbackSec      Shipped default; also sets a ceiling.
 * @param {string} envName          Name as `.env` spells it.
 * @param {string} key              Canonical name, for the bounds table.
 * @returns {number} Seconds, within range.
 * @throws {Error} When the resolved value is unusable as a delay.
 */
function parseTimerSec(value, fallbackSec, envName, key) {
  /*- `parsePositiveInt` vets the OVERRIDE and hands back the fallback
   *  untouched, so a bad default arrives here intact — which is not
   *  hypothetical: `TX_CANCEL_SEC` defaults to
   *  `deadlineSec x cancelToDeadlineMultiple`, both operator-editable. */
  const sec = parsePositiveInt(value, fallbackSec);
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
 * Parse a positive float from a string, returning `fallback` on failure.
 * @param {string|undefined} value
 * @param {number}           fallback
 * @returns {number}
 */
function parsePositiveFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

/** Resolved EIP-2718 envelope type number for the active chain. */
const TX_TYPE = TX_ENVELOPE_TYPES[CHAIN.transactionEnvelopeType] ?? 0;

/** Raw hex private key for the signing wallet (alternative to the encrypted
 *  app-config/user-configurable/wallet.json). */
const PRIVATE_KEY = process.env.PRIVATE_KEY || null;

/** Dry-run mode — read-only, no transactions. Set DRY_RUN=1 / true / yes to enable. */
const DRY_RUN = ["1", "true", "yes"].includes(
  (process.env.DRY_RUN || "").toLowerCase(),
);

/** Verbose logging (--verbose or -v on the command line, or VERBOSE=1 env). */
const VERBOSE =
  process.env.VERBOSE === "1" ||
  process.argv.includes("--verbose") ||
  process.argv.includes("-v");

module.exports = {
  parsePositiveInt,
  parseTimerSec,
  parsePositiveFloat,
  resolveChainName,
  selectChain,
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,
  PRIVATE_KEY,
  DRY_RUN,
  VERBOSE,
};
