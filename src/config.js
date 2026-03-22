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
 *
 * PRICING (optional)
 *   DEXTOOLS_API_KEY       API key for DexTools price fallback (DexScreener is primary).
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

/** % the price must move beyond the position boundary before triggering a rebalance. */
const REBALANCE_OOR_THRESHOLD_PCT = parsePositiveFloat(process.env.REBALANCE_OOR_THRESHOLD_PCT, 5);

/** Minutes of continuous OOR before auto-rebalance (0 = disabled). Default: 180 (3 hours). */
const REBALANCE_TIMEOUT_MIN = (() => {
  const n = parseInt(process.env.REBALANCE_TIMEOUT_MIN, 10);
  return Number.isFinite(n) && n >= 0 ? n : 180;
})();

/** Maximum slippage tolerance for rebalance transactions (percent). */
const SLIPPAGE_PCT = parsePositiveFloat(process.env.SLIPPAGE_PCT, 0.5);

/** Seconds before a pending TX is speed-up-replaced with higher gas. Default: 120 (2 min). */
const TX_SPEEDUP_SEC = parsePositiveInt(process.env.TX_SPEEDUP_SEC, 120);

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
  REBALANCE_OOR_THRESHOLD_PCT,
  REBALANCE_TIMEOUT_MIN,
  SLIPPAGE_PCT,
  TX_SPEEDUP_SEC,
  CHECK_INTERVAL_SEC,
  MIN_REBALANCE_INTERVAL_MIN,
  MAX_REBALANCES_PER_DAY,
  LOG_FILE,

  // Contracts
  POSITION_MANAGER,
  FACTORY,
  SWAP_ROUTER,

  // Pricing
  DEXTOOLS_API_KEY,

  // Helpers
  assertLiveModeReady,

  // Internals exposed for testing
  _parsePositiveInt:   parsePositiveInt,
  _parsePositiveFloat: parsePositiveFloat,
};
