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
 *   RANGE_WIDTH_PCT        New range width ±% after each rebalance. Default: 20
 *   SLIPPAGE_PCT           Max slippage tolerance.               Default: 0.5
 *   CHECK_INTERVAL_SEC     How often the bot polls on-chain.     Default: 60
 *   MIN_REBALANCE_INTERVAL_MIN  Min minutes between rebalances.  Default: 10
 *   MAX_REBALANCES_PER_DAY      Daily rebalance cap.             Default: 20
 *   LOG_FILE               Path for the JSON rebalance log.      Default: './rebalance_log.json'
 *
 * CONTRACTS (9mm Pro V3 on PulseChain — verify on scan.9mm.pro)
 *   POSITION_MANAGER       NonfungiblePositionManager address.
 *   FACTORY                V3 factory address.
 *   SWAP_ROUTER            V3 SwapRouter address.
 *   QUOTER_V2              QuoterV2 address.
 *
 * PRICING (optional)
 *   DEXTOOLS_API_KEY       API key for DexTools price fallback (DexScreener is primary).
 *
 * OPTIMIZER (optional — leave blank to disable)
 *   OPTIMIZER_PORT         TCP port the Optimization Engine listens on. Default: 3693.
 *                          Used to build the default OPTIMIZER_URL when that is not set.
 *   OPTIMIZER_URL          Full base URL of the LP Optimization Engine.
 *                          Defaults to http://localhost:{OPTIMIZER_PORT} when not set.
 *   OPTIMIZER_API_KEY      Bearer token for Authorization header (if the engine requires auth).
 *   OPTIMIZER_INTERVAL_MIN How often to auto-query the engine, in minutes. Default: 10.
 *   OPTIMIZER_TIMEOUT_MS   Per-request timeout in ms. Default: 10 000.
 *   OPTIMIZER_AUTO_APPLY   Whether to auto-apply recommendations when engine is toggled ON.
 *                          '1' or 'true' to enable. Default: false.
 *
 * @example
 * const { PORT, HOST, RPC_URL } = require('./src/config');
 * console.log(`Serving on http://${HOST}:${PORT}`);
 */

'use strict';

// Load .env file if present (silently skip in production where env vars are
// injected by the platform).
try {
  require('dotenv').config();
} catch (_) {
  // dotenv not installed or .env absent — rely on process.env as-is
}

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
const HOST = process.env.HOST || '0.0.0.0';

// ── Bot / wallet ───────────────────────────────────────────────────────────────

/** Raw hex private key for the signing wallet (required unless KEY_FILE is set). */
const PRIVATE_KEY = process.env.PRIVATE_KEY || null;

/** Path to an encrypted key file created by key-store.js (alternative to PRIVATE_KEY). */
const KEY_FILE = process.env.KEY_FILE || null;

/** Password to decrypt KEY_FILE (required when KEY_FILE is set). */
const KEY_PASSWORD = process.env.KEY_PASSWORD || null;

/** Password to decrypt a dashboard-imported wallet (.wallet.json) at startup. */
const WALLET_PASSWORD = process.env.WALLET_PASSWORD || null;

/** Dry-run mode — read-only, no transactions. Set to '1' or 'true' to enable. */
const DRY_RUN = ['1', 'true', 'yes'].includes(
  (process.env.DRY_RUN || '').toLowerCase(),
);

/** Primary PulseChain JSON-RPC endpoint. */
const RPC_URL = process.env.RPC_URL || 'https://rpc-pulsechain.g4mm4.io';

/** Fallback RPC endpoint — used automatically if the primary is unreachable. */
const RPC_URL_FALLBACK = process.env.RPC_URL_FALLBACK || 'https://rpc.pulsechain.com';

/** NFT token ID for single-position NFT mode (optional). */
const POSITION_ID = process.env.POSITION_ID || null;

/** ERC-20 / PRC-20 position token contract address (optional fallback). */
const ERC20_POSITION_ADDRESS = process.env.ERC20_POSITION_ADDRESS || null;

/** Width of the new LP range after each rebalance, as a ± percentage. */
const RANGE_WIDTH_PCT = parsePositiveFloat(process.env.RANGE_WIDTH_PCT, 20);

/** Maximum slippage tolerance for rebalance transactions (percent). */
const SLIPPAGE_PCT = parsePositiveFloat(process.env.SLIPPAGE_PCT, 0.5);

/** How often the bot checks the on-chain position, in seconds. */
const CHECK_INTERVAL_SEC = parsePositiveInt(process.env.CHECK_INTERVAL_SEC, 60);

/** Minimum time that must elapse between two rebalances, in minutes. */
const MIN_REBALANCE_INTERVAL_MIN = parsePositiveInt(
  process.env.MIN_REBALANCE_INTERVAL_MIN, 10,
);

/** Maximum rebalances permitted within a single 24-hour window. */
const MAX_REBALANCES_PER_DAY = parsePositiveInt(
  process.env.MAX_REBALANCES_PER_DAY, 20,
);

/** File path for the JSON rebalance event log. */
const LOG_FILE = process.env.LOG_FILE || './rebalance_log.json';

// ── Optimizer ──────────────────────────────────────────────────────────────────

/**
 * TCP port the LP Optimization Engine listens on.
 * Used to build the default OPTIMIZER_URL when that env var is not explicitly set.
 */
const OPTIMIZER_PORT = parsePositiveInt(process.env.OPTIMIZER_PORT, 3693);

/**
 * Base URL of the LP Optimization Engine.
 * When OPTIMIZER_URL is not set, defaults to http://localhost:{OPTIMIZER_PORT}.
 * Set to null only when explicitly passed as empty string, signalling "disabled".
 */
const OPTIMIZER_URL = process.env.OPTIMIZER_URL !== undefined
  ? (process.env.OPTIMIZER_URL.trim() || null)
  : `http://localhost:${OPTIMIZER_PORT}`;

/** Bearer token for the Optimization Engine's Authorization header. */
const OPTIMIZER_API_KEY = process.env.OPTIMIZER_API_KEY || null;

/** How often to auto-query the engine, in minutes (when the toggle is ON). */
const OPTIMIZER_INTERVAL_MIN = parsePositiveInt(process.env.OPTIMIZER_INTERVAL_MIN, 10);

/** Per-request timeout for optimizer HTTP calls, in ms. */
const OPTIMIZER_TIMEOUT_MS = parsePositiveInt(process.env.OPTIMIZER_TIMEOUT_MS, 10_000);

/**
 * Whether to automatically apply recommendations when the toggle is ON.
 * When false, recommendations are fetched and displayed but not applied
 * until the user clicks "Apply".
 */
const OPTIMIZER_AUTO_APPLY = ['1', 'true', 'yes'].includes(
  (process.env.OPTIMIZER_AUTO_APPLY || '').toLowerCase(),
);

// ── Contracts ──────────────────────────────────────────────────────────────────

/**
 * NonfungiblePositionManager contract address (9mm Pro V3 on PulseChain).
 * Source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json
 */
const POSITION_MANAGER = process.env.POSITION_MANAGER
  || '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2';

/**
 * V3 factory contract address (9mm Pro on PulseChain).
 * Source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json
 */
const FACTORY = process.env.FACTORY
  || '0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68';

/**
 * V3 SwapRouter contract address (9mm Pro on PulseChain).
 * Used for token swaps during rebalancing.
 */
const SWAP_ROUTER = process.env.SWAP_ROUTER
  || '0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA';

/**
 * QuoterV2 contract address (9mm Pro on PulseChain).
 * Used for on-chain price quotes.
 */
const QUOTER_V2 = process.env.QUOTER_V2
  || '0x500260dD7C27eCE20b89ea0808d05a13CF867279';

// ── Pricing ───────────────────────────────────────────────────────────────────

/** DexTools API key for USD price fallback (DexScreener is tried first). */
const DEXTOOLS_API_KEY = process.env.DEXTOOLS_API_KEY || null;

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
    missing.push('PRIVATE_KEY (or KEY_FILE + KEY_PASSWORD)');
  }
  if (KEY_FILE && !KEY_PASSWORD) {
    missing.push('KEY_PASSWORD (required when KEY_FILE is set)');
  }
  if (!RPC_URL) missing.push('RPC_URL');
  if (missing.length > 0) {
    throw new Error(
      'Missing required configuration for live-bot mode:\n' +
      missing.map(k => `  • ${k}`).join('\n') +
      '\nSet these in your .env file or as environment variables.',
    );
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Server
  PORT,
  HOST,

  // Bot
  PRIVATE_KEY,
  KEY_FILE,
  KEY_PASSWORD,
  WALLET_PASSWORD,
  DRY_RUN,
  RPC_URL,
  RPC_URL_FALLBACK,
  POSITION_ID,
  ERC20_POSITION_ADDRESS,
  RANGE_WIDTH_PCT,
  SLIPPAGE_PCT,
  CHECK_INTERVAL_SEC,
  MIN_REBALANCE_INTERVAL_MIN,
  MAX_REBALANCES_PER_DAY,
  LOG_FILE,

  // Optimizer
  OPTIMIZER_PORT,
  OPTIMIZER_URL,
  OPTIMIZER_API_KEY,
  OPTIMIZER_INTERVAL_MIN,
  OPTIMIZER_TIMEOUT_MS,
  OPTIMIZER_AUTO_APPLY,

  // Contracts
  POSITION_MANAGER,
  FACTORY,
  SWAP_ROUTER,
  QUOTER_V2,

  // Pricing
  DEXTOOLS_API_KEY,

  // Helpers
  assertLiveModeReady,

  // Internals exposed for testing
  _parsePositiveInt:   parsePositiveInt,
  _parsePositiveFloat: parsePositiveFloat,
};
