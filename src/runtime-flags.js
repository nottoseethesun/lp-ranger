/**
 * @file src/runtime-flags.js
 * @module runtime-flags
 * @description
 * Runtime, environment-derived flags and helpers for LP Ranger. Anything
 * sourced from `process.env`, `process.argv`, or computed by selecting a
 * row out of `app-config/static-tunables/chains.json` lives here. Pure
 * tracked data (ports, timeouts, aggregator URL, etc.) lives in
 * `src/config.json` instead.
 *
 * `src/config.js` re-exports everything here so existing callers keep
 * working — new code can import directly from this module when it only
 * needs runtime flags and wants to avoid pulling in the rest of the
 * config surface.
 */

"use strict";

const dotenv = require("dotenv");
const CHAINS = require("../app-config/static-tunables/chains.json");

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
 * Parse a positive float from a string, returning `fallback` on failure.
 * @param {string|undefined} value
 * @param {number}           fallback
 * @returns {number}
 */
function parsePositiveFloat(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Active chain name. Set CHAIN_NAME=pulsechain-testnet for testnet. */
const CHAIN_NAME = (process.env.CHAIN_NAME || "pulsechain").toLowerCase();

/** Active chain config (aggregator tunables, chainId, contracts, etc.). */
const CHAIN = CHAINS[CHAIN_NAME] || CHAINS.pulsechain;

/** Map human-readable names to EIP-2718 transaction envelope type numbers. */
const TX_ENVELOPE_TYPES = { legacy: 0, eip1559: 2 };

/** Resolved EIP-2718 envelope type number for the active chain. */
const TX_TYPE = TX_ENVELOPE_TYPES[CHAIN.transactionEnvelopeType] ?? 0;

/** Raw hex private key for the signing wallet (alternative to .wallet.json). */
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
  parsePositiveFloat,
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,
  PRIVATE_KEY,
  DRY_RUN,
  VERBOSE,
};
