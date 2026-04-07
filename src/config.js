/**
 * @file src/config.js
 * @module config
 * @description
 * Single source of truth for all runtime configuration in the 9mm v3
 * position manager.  Reads values from environment variables (populated by
 * a `.env` file via `dotenv`) and applies defaults for every optional setting.
 *
 * All other modules should import config values from here rather than reading
 * `process.env` directly.  This keeps configuration centralised, documented,
 * and easy to override in tests by mutating the exported object.
 *
 * Configuration keys
 * ──────────────────
 * SERVER
 *   PORT                   HTTP port for the dashboard server.   Default: 5555
 *   HOST                   Bind address.                         Default: '0.0.0.0'
 *
 * BOT
 *   PRIVATE_KEY            Wallet private key (required unless KEY_FILE is set).
 *   KEY_FILE               Path to an encrypted key file (alternative to PRIVATE_KEY).
 *   KEY_PASSWORD           Password to decrypt KEY_FILE (required when KEY_FILE is set).
 *   RPC_URL                PulseChain RPC endpoint (default: g4mm4.io).
 *   RPC_URL_FALLBACK       Fallback RPC (default: rpc.pulsechain.com).
 *   POSITION_ID            NFT token ID (optional — auto-detected otherwise).
 *   ERC20_POSITION_ADDRESS ERC-20 position token contract (optional).
 *   REBALANCE_OOR_THRESHOLD_PCT  % price must move beyond boundary before rebalance. Default: 5
 *   SLIPPAGE_PCT           Max slippage tolerance.               Default: 0.75
 *   CHECK_INTERVAL_SEC     How often the bot polls on-chain.     Default: 60
 *   MIN_REBALANCE_INTERVAL_MIN  Min minutes between rebalances.  Default: 10
 *   MAX_REBALANCES_PER_DAY      Daily rebalance cap.             Default: 20
 *   LOG_FILE               Path for the JSON rebalance log.      Default: './rebalance_log.json'
 *
 * CONTRACTS (9mm Pro V3 on PulseChain — verify on scan.9mm.pro)
 *   POSITION_MANAGER       NonfungiblePositionManager address.
 *   FACTORY                V3 factory address.
 *   SWAP_ROUTER            V3 SwapRouter address.
 *
 *
 * @example
 * const { PORT, HOST, RPC_URL } = require('./src/config');
 * console.log(`Serving on http://${HOST}:${PORT}`);
 */

"use strict";

const path = require("path");

// Load .env file if present (silently skip in production where env vars are
// injected by the platform).
try {
  require("dotenv").config();
} catch (_) {
  // dotenv not installed or .env absent — rely on process.env as-is
}

// ── Per-blockchain config ────────────────────────────────────────────────────

/** Per-blockchain settings loaded from config/chains.json. */
const CHAINS = require(path.join(__dirname, "..", "config", "chains.json"));

/** Active chain name. Set CHAIN_NAME=pulsechain-testnet for testnet. */
const CHAIN_NAME = (process.env.CHAIN_NAME || "pulsechain").toLowerCase();

/** Active chain config (aggregator tunables, chainId, etc.). */
const CHAIN = CHAINS[CHAIN_NAME] || CHAINS.pulsechain;

/** Map human-readable names to EIP-2718 transaction envelope type numbers. */
const TX_ENVELOPE_TYPES = { legacy: 0, eip1559: 2 };

/** Resolved EIP-2718 envelope type number for the active chain. */
const TX_TYPE = TX_ENVELOPE_TYPES[CHAIN.transactionEnvelopeType] ?? 0;

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

// ── Server ─────────────────────────────────────────────────────────────────────

/** HTTP port the dashboard server listens on. */
const PORT = parsePositiveInt(process.env.PORT, 5555);

/** Network interface the server binds to. '0.0.0.0' = all interfaces. */
const HOST = process.env.HOST || "0.0.0.0";

// ── Bot / wallet ───────────────────────────────────────────────────────────────

/** Raw hex private key for the signing wallet (required unless KEY_FILE is set). */
const PRIVATE_KEY = process.env.PRIVATE_KEY || null;

/** Path to an encrypted key file created by key-store.js (alternative to PRIVATE_KEY). */
const KEY_FILE = process.env.KEY_FILE || null;

/** Password to decrypt KEY_FILE (required when KEY_FILE is set). */
const KEY_PASSWORD = process.env.KEY_PASSWORD || null;

/** Dry-run mode — read-only, no transactions. Set to '1' or 'true' to enable. */
const DRY_RUN = ["1", "true", "yes"].includes(
  (process.env.DRY_RUN || "").toLowerCase(),
);

/** Primary JSON-RPC endpoint (chain-aware default from chains.json). */
const RPC_URL =
  process.env.RPC_URL ||
  CHAIN.rpc?.primary ||
  "https://rpc-pulsechain.g4mm4.io";

/** Fallback RPC endpoint — used automatically if the primary is unreachable. */
const RPC_URL_FALLBACK =
  process.env.RPC_URL_FALLBACK ||
  CHAIN.rpc?.fallback ||
  "https://rpc.pulsechain.com";

/** NFT token ID for single-position NFT mode (optional). */
const POSITION_ID = process.env.POSITION_ID || null;

/** ERC-20 / PRC-20 position token contract address (optional fallback). */
const ERC20_POSITION_ADDRESS = process.env.ERC20_POSITION_ADDRESS || null;

/** % the price must move beyond the position boundary before triggering a rebalance. */
const REBALANCE_OOR_THRESHOLD_PCT = parsePositiveFloat(
  process.env.REBALANCE_OOR_THRESHOLD_PCT,
  5,
);

/** Minutes of continuous OOR before auto-rebalance (0 = disabled). Default: 180 (3 hours). */
const REBALANCE_TIMEOUT_MIN = (() => {
  const n = parseInt(process.env.REBALANCE_TIMEOUT_MIN, 10);
  return Number.isFinite(n) && n >= 0 ? n : 180;
})();

/** Default slippage tolerance (percent). Fallback when user input is invalid. */
const DEFAULT_SLIPPAGE_PCT = 0.75;

/** Maximum slippage tolerance for rebalance transactions (percent). */
const SLIPPAGE_PCT = parsePositiveFloat(
  process.env.SLIPPAGE_PCT,
  DEFAULT_SLIPPAGE_PCT,
);

/** Seconds before a pending TX is speed-up-replaced with higher gas. Default: 120 (2 min). */
const TX_SPEEDUP_SEC = parsePositiveInt(process.env.TX_SPEEDUP_SEC, 120);

/** Seconds before a stuck TX is cancelled with a 0-PLS self-transfer. Default: 1200 (20 min). */
const TX_CANCEL_SEC = parsePositiveInt(process.env.TX_CANCEL_SEC, 1200);

/** How often the bot checks the on-chain position, in seconds. */
const CHECK_INTERVAL_SEC = parsePositiveInt(process.env.CHECK_INTERVAL_SEC, 60);

/** Minimum time that must elapse between two rebalances, in minutes. */
const MIN_REBALANCE_INTERVAL_MIN = parsePositiveInt(
  process.env.MIN_REBALANCE_INTERVAL_MIN,
  10,
);

/** Maximum rebalances per liquidity pool within a single 24-hour window. */
const MAX_REBALANCES_PER_DAY = parsePositiveInt(
  process.env.MAX_REBALANCES_PER_DAY,
  5,
);

/**
 * Maximum consecutive swap-backoff retries before pausing.
 * When a swap's price impact moves the tick outside the computed range,
 * the bot backs off with exponential delay (1→2→4→…→20 min).
 * After this many failures the bot pauses and alerts the user.
 */
const REBALANCE_RETRY_SWAP_LIMIT = parsePositiveInt(
  process.env.REBALANCE_RETRY_SWAP_LIMIT,
  8,
);

/** File path for the JSON rebalance event log. */
const LOG_FILE = process.env.LOG_FILE || "./rebalance_log.json";

// ── Contracts ──────────────────────────────────────────────────────────────────

/**
 * NonfungiblePositionManager contract address (9mm Pro V3 on PulseChain).
 * Source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json
 */
const POSITION_MANAGER =
  process.env.POSITION_MANAGER ||
  CHAIN.contracts?.positionManager?.address ||
  "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

/**
 * V3 factory contract address (chain-aware default from chains.json).
 * Source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json
 */
const FACTORY =
  process.env.FACTORY ||
  CHAIN.contracts?.factory ||
  "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";

/**
 * V3 SwapRouter contract address (chain-aware default from chains.json).
 * Used for token swaps during rebalancing.
 */
const SWAP_ROUTER =
  process.env.SWAP_ROUTER ||
  CHAIN.contracts?.swapRouter ||
  "0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA";

/** 9mm DEX Aggregator API URL (primary swap path — lowest slippage). */
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || "https://api.9mm.pro";

/** 0x-api-key for the 9mm DEX Aggregator (required for valid calldata). */
const AGGREGATOR_API_KEY =
  process.env.AGGREGATOR_API_KEY || "f9275849-2a1d-406b-b2a2-a6be1ac127dc";

// ── Validation helper ─────────────────────────────────────────────────────────

/**
 * Assert that all required config values are present for live-bot operation.
 * Throws a descriptive error listing every missing value so the user can fix
 * them all at once rather than discovering them one by one.
 *
 * @throws {Error} If any required field is absent.
 */
function assertLiveModeReady() {
  const missing = [];
  const hasKeyFile = KEY_FILE && KEY_PASSWORD;
  if (!PRIVATE_KEY && !hasKeyFile) {
    missing.push("PRIVATE_KEY (or KEY_FILE + KEY_PASSWORD)");
  }
  if (KEY_FILE && !KEY_PASSWORD) {
    missing.push("KEY_PASSWORD (required when KEY_FILE is set)");
  }
  if (!RPC_URL) missing.push("RPC_URL");
  if (missing.length > 0) {
    throw new Error(
      "Missing required configuration for live-bot mode:\n" +
        missing.map((k) => `  • ${k}`).join("\n") +
        "\nSet these in your .env file or as environment variables.",
    );
  }
}

/** Verbose logging (--verbose or -v on command line, or VERBOSE=1 env). */
const VERBOSE =
  process.env.VERBOSE === "1" ||
  process.argv.includes("--verbose") ||
  process.argv.includes("-v");

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Server
  PORT,
  HOST,

  // Bot
  PRIVATE_KEY,
  KEY_FILE,
  KEY_PASSWORD,
  DRY_RUN,
  RPC_URL,
  RPC_URL_FALLBACK,
  POSITION_ID,
  ERC20_POSITION_ADDRESS,
  REBALANCE_OOR_THRESHOLD_PCT,
  REBALANCE_TIMEOUT_MIN,
  DEFAULT_SLIPPAGE_PCT,
  SLIPPAGE_PCT,
  TX_SPEEDUP_SEC,
  TX_CANCEL_SEC,
  CHECK_INTERVAL_SEC,
  MIN_REBALANCE_INTERVAL_MIN,
  MAX_REBALANCES_PER_DAY,
  REBALANCE_RETRY_SWAP_LIMIT,
  LOG_FILE,

  // Contracts
  POSITION_MANAGER,
  FACTORY,
  SWAP_ROUTER,
  AGGREGATOR_URL,
  AGGREGATOR_API_KEY,

  // Per-blockchain
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,

  // Compound
  COMPOUND_MIN_FEE_USD: 1,
  COMPOUND_DEFAULT_THRESHOLD_USD: 5,

  // Helpers
  assertLiveModeReady,
  VERBOSE,

  // Internals exposed for testing
  _parsePositiveInt: parsePositiveInt,
  _parsePositiveFloat: parsePositiveFloat,
};
