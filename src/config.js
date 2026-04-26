/**
 * @file src/config.js
 * @module config
 * @description
 * Single import point for all runtime configuration in LP Ranger. Composes
 * three sources:
 *
 *   1. `src/config.json`                              — tracked, pure data
 *      (server port/host, TX timeouts, aggregator URL/key, scan/compound/log
 *      defaults). Override per-deployment via env vars where documented.
 *   2. `src/runtime-flags.js`                         — env/argv-derived
 *      (PRIVATE_KEY, DRY_RUN, VERBOSE, CHAIN, CHAIN_NAME, TX_TYPE, parser
 *      helpers).
 *   3. `app-config/static-tunables/chains.json`       — per-chain RPC URLs
 *      and contract addresses.
 *
 * Per-position user-tunable settings (OOR threshold, slippage, intervals,
 * rebalance cap, OOR timeout) are still read from env vars here for the
 * moment; they will move to `app-config/static-tunables/bot-config-defaults.json`
 * in a follow-up commit. Until then, the env vars remain the source of
 * truth for first-time defaults.
 *
 * Existing callers keep importing `./config` and see the same exported
 * shape they always have. New code that only needs runtime flags can
 * `require('./runtime-flags')` directly.
 */

"use strict";

const APP_CONFIG = require("./config.json");
const runtimeFlags = require("./runtime-flags");
const walletManager = require("./wallet-manager");

const {
  parsePositiveInt,
  parsePositiveFloat,
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,
  PRIVATE_KEY,
  DRY_RUN,
  VERBOSE,
} = runtimeFlags;

// ── Server ─────────────────────────────────────────────────────────────────────

/** HTTP port the dashboard server listens on. */
const PORT = parsePositiveInt(process.env.PORT, APP_CONFIG.server.port);

/** Network interface the server binds to. '127.0.0.1' = localhost only. */
const HOST = process.env.HOST || APP_CONFIG.server.host;

// ── Bot / wallet ───────────────────────────────────────────────────────────────

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

/** Default slippage tolerance (percent). Hard fallback when user input is invalid. */
const DEFAULT_SLIPPAGE_PCT = 0.75;

/** Maximum slippage tolerance for rebalance transactions (percent). */
const SLIPPAGE_PCT = parsePositiveFloat(
  process.env.SLIPPAGE_PCT,
  DEFAULT_SLIPPAGE_PCT,
);

/** Seconds before a pending TX is speed-up-replaced with higher gas. */
const TX_SPEEDUP_SEC = parsePositiveInt(
  process.env.TX_SPEEDUP_SEC,
  APP_CONFIG.tx.speedupSec,
);

/** Seconds before a stuck TX is cancelled with a 0-PLS self-transfer. */
const TX_CANCEL_SEC = parsePositiveInt(
  process.env.TX_CANCEL_SEC,
  APP_CONFIG.tx.cancelSec,
);

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
 * Maximum consecutive swap-backoff retries before pausing. When a swap's
 * price impact moves the tick outside the computed range, the bot backs
 * off with exponential delay (1 → 2 → 4 → … → 20 min). After this many
 * failures the bot pauses and alerts the user.
 */
const REBALANCE_RETRY_SWAP_LIMIT = parsePositiveInt(
  process.env.REBALANCE_RETRY_SWAP_LIMIT,
  APP_CONFIG.tx.retrySwapLimit,
);

/** File path for the JSON rebalance event log. */
const LOG_FILE = process.env.LOG_FILE || APP_CONFIG.log.file;

// ── Contracts ──────────────────────────────────────────────────────────────────

/** NonfungiblePositionManager contract address (chain-aware default). */
const POSITION_MANAGER =
  process.env.POSITION_MANAGER ||
  CHAIN.contracts?.positionManager?.address ||
  "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

/** V3 factory contract address (chain-aware default). */
const FACTORY =
  process.env.FACTORY ||
  CHAIN.contracts?.factory ||
  "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";

/** V3 SwapRouter contract address (chain-aware default). */
const SWAP_ROUTER =
  process.env.SWAP_ROUTER ||
  CHAIN.contracts?.swapRouter ||
  "0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA";

/** 9mm DEX Aggregator API URL (primary swap path — lowest slippage). */
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || APP_CONFIG.aggregator.url;

/** 0x-api-key for the 9mm DEX Aggregator (required for valid calldata). */
const AGGREGATOR_API_KEY =
  process.env.AGGREGATOR_API_KEY || APP_CONFIG.aggregator.apiKey;

// ── Validation helper ─────────────────────────────────────────────────────────

/**
 * Assert that all required config values are present for live-bot
 * operation. Throws a descriptive error listing every missing value so
 * the user can fix them all at once rather than discovering them one by
 * one.
 *
 * @throws {Error} If any required field is absent.
 */
function assertLiveModeReady() {
  const missing = [];
  if (!PRIVATE_KEY && !walletManager.hasWallet()) {
    missing.push(
      "PRIVATE_KEY in .env, or import a wallet via " +
        "`node scripts/import-wallet.js` (or the dashboard)",
    );
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Server
  PORT,
  HOST,

  // Bot
  PRIVATE_KEY,
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
  COMPOUND_MIN_FEE_USD: APP_CONFIG.compound.minFeeUsd,
  COMPOUND_DEFAULT_THRESHOLD_USD: APP_CONFIG.compound.defaultThresholdUsd,

  // Scan
  SCAN_TIMEOUT_MS: APP_CONFIG.scan.timeoutMs,

  // Helpers
  assertLiveModeReady,
  VERBOSE,

  // Internals exposed for testing
  _parsePositiveInt: parsePositiveInt,
  _parsePositiveFloat: parsePositiveFloat,
};
