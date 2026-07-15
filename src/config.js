/**
 * @file src/config.js
 * @module config
 * @description
 * Single import point for all runtime configuration in LP Ranger.
 * Every default value comes from a shipped JSON file under
 * `app-config/app-defaults-for-user-configurable/`, deep-merged with
 * any matching operator override under `app-config/user-configurable/`
 * via `loadMergedDefaults()`.  Env vars and runtime flags layer ON
 * TOP of that.  Per feedback_one_literal_per_shipped_default — every
 * shipped default has exactly one literal in the entire codebase, and
 * that literal lives in the JSON file.
 *
 * Composes three sources:
 *
 *   1. `app-runtime.json`         — server port/host, TX timeouts,
 *      aggregator URL/key, scan/compound/log defaults.  Operator can
 *      override individual keys via
 *      `app-config/user-configurable/app-runtime.json` (gitignored,
 *      tarball-upgrade safe).  Env vars override that.
 *   2. `bot-config-defaults.json` — shipped defaults for every
 *      operator-tunable Bot Setting (OOR threshold, slippage,
 *      intervals, daily cap, OOR timeout, etc.).  Sourced once at
 *      module init for the env-var fallback expressions below.
 *   3. `src/runtime-flags.js`     — env/argv-derived (PRIVATE_KEY,
 *      DRY_RUN, VERBOSE, CHAIN, CHAIN_NAME, TX_TYPE, parser helpers).
 *      `chains.json` is loaded inside runtime-flags via the same
 *      layered loader.
 *
 * Existing callers keep importing `./config` and see the same
 * exported shape they always have.  New code that only needs runtime
 * flags can `require('./runtime-flags')` directly.
 */

"use strict";

const runtimeFlags = require("./runtime-flags");
const walletManager = require("./wallet-manager");
const { loadMergedDefaults } = require("./load-merged-defaults");

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

/*- Shipped app-runtime defaults, merged with any operator override at
 *  `app-config/user-configurable/app-runtime.json`.  Loaded once at
 *  module init; used below as the env-var-fallback expression in every
 *  consumer so no numeric/string default is literally written in this
 *  file. */
const APP_CONFIG = loadMergedDefaults("app-runtime.json");

/*- Single-source baseline for every Bot-Setting default value: read
 *  the merged JSON once at module init.  Used below as the
 *  env-var-fallback expression in every `parsePositiveInt/Float` call
 *  site so no numeric default is ever literally written in this file. */
const _BOT_DEFAULTS = loadMergedDefaults("bot-config-defaults.json");

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
  _BOT_DEFAULTS.rebalanceOutOfRangeThresholdPercent,
);

/** Minutes of continuous OOR before auto-rebalance (0 = disabled). */
const REBALANCE_TIMEOUT_MIN = (() => {
  const n = parseInt(process.env.REBALANCE_TIMEOUT_MIN, 10);
  return Number.isFinite(n) && n >= 0 ? n : _BOT_DEFAULTS.rebalanceTimeoutMin;
})();

/** Default slippage tolerance (percent). Hard fallback when user input is invalid. */
const DEFAULT_SLIPPAGE_PCT = _BOT_DEFAULTS.slippagePct;

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

/*- On-chain contract deadline (seconds) stamped into removeLiquidity /
 *  swap / mint calldata.  Sourced from app-runtime.json — see the
 *  `tx._comment` block there for the full explanation. */
const DEADLINE_SEC = parsePositiveInt(
  process.env.DEADLINE_SEC,
  APP_CONFIG.tx.deadlineSec,
);

/*- Seconds before a stuck TX is cancelled with a 0-PLS self-transfer.
 *  DERIVED from `deadlineSec × cancelToDeadlineMultiple` (both in
 *  app-runtime.json) so the two values can't drift.  The environment
 *  override still wins if operators need to force a specific value. */
const TX_CANCEL_SEC = parsePositiveInt(
  process.env.TX_CANCEL_SEC,
  DEADLINE_SEC * APP_CONFIG.tx.cancelToDeadlineMultiple,
);

/** How often the bot checks the on-chain position, in seconds. */
const CHECK_INTERVAL_SEC = parsePositiveInt(
  process.env.CHECK_INTERVAL_SEC,
  _BOT_DEFAULTS.checkIntervalSec,
);

/** Minimum time that must elapse between two rebalances, in minutes. */
const MIN_REBALANCE_INTERVAL_MIN = parsePositiveInt(
  process.env.MIN_REBALANCE_INTERVAL_MIN,
  _BOT_DEFAULTS.minRebalanceIntervalMin,
);

/** Maximum rebalances per liquidity pool within a single 24-hour window. */
const MAX_REBALANCES_PER_DAY = parsePositiveInt(
  process.env.MAX_REBALANCES_PER_DAY,
  _BOT_DEFAULTS.maxRebalancesPerDay,
);

/**
 * Maximum consecutive swap-backoff retries before pausing. When a swap's
 * price impact moves the tick outside the computed range, the bot backs
 * off with exponential delay (1 → 2 → 4 → … → 20 min). After this many
 * failures the bot pauses and alerts the user.
 */
/**
 * Dashboard's /api/status poll interval (ms).  Hardcoded in
 * `public/dashboard-data-poll.js` — exported here as the
 * single source of truth so server-side timing logic that depends on
 * "the dashboard has had a chance to poll N times" stays in sync if
 * the interval ever changes.  Update both sites together; a unit test
 * could enforce the match.
 */
const DASHBOARD_POLL_INTERVAL_MS = 3000;

/**
 * Minimum elapsed wall-clock time after a server-side state change
 * before we can assume the dashboard has POLLED at least once and
 * captured it.  Set to 2.5× the poll interval to comfortably cover
 * 2-3 polls even with jitter / a poll just having fired before the
 * change.  Used by `bot-loop.js`'s re-open-failure path to delay the
 * auto-retire so the dashboard reliably sees `rebalancePaused=true`
 * and fires its alert modal before the state is deleted on retire.
 */
const GUARANTEED_DASHBOARD_HAS_POLLED_MS = DASHBOARD_POLL_INTERVAL_MS * 2.5;

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
  DEADLINE_SEC,
  TX_CANCEL_SEC,
  CHECK_INTERVAL_SEC,
  MIN_REBALANCE_INTERVAL_MIN,
  MAX_REBALANCES_PER_DAY,
  REBALANCE_RETRY_SWAP_LIMIT,
  DASHBOARD_POLL_INTERVAL_MS,
  GUARANTEED_DASHBOARD_HAS_POLLED_MS,
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
