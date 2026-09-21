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
const { readBotConfigDefaultsStrict } = require("./bot-config-defaults");
const botConfigV2 = require("./bot-config-v2");
const { composeRpcUrls } = require("./rpc-url-list");

const {
  parsePositiveInt,
  parseTimerSec,
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

/*- Single-source baseline for every Bot-Setting default value, used
 *  below as the env-var-fallback expression in every
 *  `parsePositiveInt/Float/TimerSec` call site, so no numeric default is
 *  ever literally written in this file.
 *
 *  Read through the reader that vets, rather than `loadMergedDefaults`
 *  directly: it applies the per-key clamps declared beside the values,
 *  so an out-of-range or non-numeric override falls back to the shipped
 *  value HERE rather than travelling on as a live setting.  Reading the
 *  merged JSON raw takes the same file with none of that.
 *
 *  The STRICT variant, because this is startup.  A timer setting an
 *  operator wrote out of range stops the app here, rather than being
 *  replaced by a number nobody chose — and startup is the only place
 *  that can refuse, since the lenient reader is what a poll cycle and
 *  an HTTP route call.  See docs/engineering.md § "Reading
 *  Configuration Values". */
const _BOT_DEFAULTS = readBotConfigDefaultsStrict();

// ── Server ─────────────────────────────────────────────────────────────────────

/** HTTP port the dashboard server listens on. */
const PORT = parsePositiveInt(process.env.PORT, APP_CONFIG.server.port);

/** Network interface the server binds to. '127.0.0.1' = localhost only. */
const HOST = process.env.HOST || APP_CONFIG.server.host;

// ── Bot / wallet ───────────────────────────────────────────────────────────────

/*- Ordered RPC endpoints for the active chain.  chains.json owns the
 *  URLs — there are deliberately no literals here, per
 *  feedback_one_literal_per_shipped_default: an env-var fallback
 *  literal is a second source of truth that drifts silently when the
 *  shipped list changes.
 *
 *  Env overrides are positional and stay backward compatible: RPC_URL
 *  replaces the first entry, RPC_URL_FALLBACK the second,
 *  RPC_URL_FALLBACK_2 the third.  An operator who sets only RPC_URL
 *  keeps the shipped endpoints behind it. */
/** Ordered RPC endpoints for the active chain, from chains.json. */
const _CHAIN_RPC_URLS = Array.isArray(CHAIN.rpc?.urls) ? CHAIN.rpc.urls : [];
const _RPC_ENV_OVERRIDES = [
  process.env.RPC_URL,
  process.env.RPC_URL_FALLBACK,
  process.env.RPC_URL_FALLBACK_2,
];

/*- Endpoints the operator added with Bot Settings → Network → Add RPC,
 *  most recently added first.
 *
 *  Read quietly at module load — this runs on every import, including
 *  in tests, so it must not log or throw.  Per the documented
 *  precedence, endpoints added in Bot Settings win over the env and
 *  shipped layers; they are the most deliberate expression of intent
 *  available, and they are what the dashboard shows back to the
 *  operator.
 *
 *  They are PREPENDED rather than used as a replacement: the operator
 *  gets their endpoint tried first, and still keeps the shipped
 *  endpoints behind it as automatic failover.  Replacing the list would
 *  mean that choosing a private node also silently gives up
 *  redundancy. */
const _SAVED_RPC_URLS = (() => {
  const v = botConfigV2.readGlobalSetting("rpcUrls");
  return Array.isArray(v) ? v : [];
})();

/*- The composition rule itself lives in src/rpc-url-list.js as a pure
 *  function, so it can be driven directly by tests.  Resolving it here
 *  from live files and environment would otherwise leave the rule
 *  testable only by re-implementing it in a test, which is a mirror. */

/**
 * The shipped + env endpoint list, WITHOUT anything the operator added.
 *
 * `RPC_URLS` mixes the two, so recomposing from it would re-seed the
 * saved entries on every save and make them impossible to remove. The
 * server recomposes from this base plus the freshly saved list.
 * @type {string[]}
 */
const RPC_URLS_BASE = composeRpcUrls({
  envOverrides: _RPC_ENV_OVERRIDES,
  chainUrls: _CHAIN_RPC_URLS,
});

const RPC_URLS = composeRpcUrls({
  saved: _SAVED_RPC_URLS,
  envOverrides: _RPC_ENV_OVERRIDES,
  chainUrls: _CHAIN_RPC_URLS,
});

/** Primary JSON-RPC endpoint — first entry of `RPC_URLS`. */
const RPC_URL = RPC_URLS[0] || "";

/**
 * Replace the live endpoint list, in place, after the operator adds one.
 *
 * Mutates rather than rebinding because `RPC_URLS` is read directly by
 * `src/rpc-endpoints.js`, `src/rebalancer-pools.js` and
 * `src/server-can-reopen.js`, each of which captured the array. A
 * rebind would leave all three walking the endpoints the process
 * started with.
 * @param {string[]} urls  Ordered endpoints, most-preferred first.
 * @returns {void}
 */
function setRpcUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("[config] setRpcUrls: expected a non-empty array");
  }
  RPC_URLS.splice(0, RPC_URLS.length, ...urls);
}

/** NFT token ID for single-position NFT mode (optional). */
const POSITION_ID = process.env.POSITION_ID || null;

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
const TX_SPEEDUP_SEC = parseTimerSec(
  process.env.TX_SPEEDUP_SEC,
  APP_CONFIG.tx.speedupSec,
  "TX_SPEEDUP_SEC",
  "txSpeedupSec",
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
const TX_CANCEL_SEC = parseTimerSec(
  process.env.TX_CANCEL_SEC,
  DEADLINE_SEC * APP_CONFIG.tx.cancelToDeadlineMultiple,
  "TX_CANCEL_SEC",
  "txCancelSec",
);

/** How often the bot checks the on-chain position, in seconds. */
const CHECK_INTERVAL_SEC = parseTimerSec(
  process.env.CHECK_INTERVAL_SEC,
  _BOT_DEFAULTS.checkIntervalSec,
  "CHECK_INTERVAL_SEC",
  "checkIntervalSec",
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
 * Impermanent Loss Guard, percent.  The single literal lives in
 * `bot-config-defaults.json`; this is the read, and `/api/status`
 * publishes it through `posDefaults` so the Auto-Rebalance Settings
 * badge shows the value in force on a position that has never had one
 * saved, rather than an em-dash.
 *
 * Env-over-JSON like every tunable around it, per this file's header:
 * shipped default, operator override, then env on top.  That layer is
 * what makes a setting reachable on a headless install, where there is
 * no Bot Settings panel to press Save in.  `src/il-guard.js` reads this
 * same export for its fallback, so the badge and the enforced threshold
 * cannot disagree — reading the JSON directly there is what made
 * `IMPERMANENT_LOSS_GUARD_PCT=30` show 30 while the bot enforced 50.
 */
const IMPERMANENT_LOSS_GUARD_PCT = parsePositiveInt(
  process.env.IMPERMANENT_LOSS_GUARD_PCT,
  _BOT_DEFAULTS.impermanentLossGuardPct,
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
  RPC_URLS,
  RPC_URLS_BASE,
  setRpcUrls,
  POSITION_ID,
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
  IMPERMANENT_LOSS_GUARD_PCT,
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

  // Re-scan Prices dialog: how long the button waits before it is
  // handed back.  Bounds the dialog, not the scan.
  RESCAN_PRICES_TIMEOUT_MS: APP_CONFIG.rescanPrices.timeoutMs,

  // Helpers
  assertLiveModeReady,
  VERBOSE,

  // Internals exposed for testing
  _parsePositiveInt: parsePositiveInt,
  _parsePositiveFloat: parsePositiveFloat,
};
