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
 *      scan/compound/log defaults.  Operator can
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
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");
const { readBotConfigDefaultsStrict } = require("./bot-config-defaults");
const { readUiDefaultsStrict } = require("./ui-defaults");
const botConfigV2 = require("./bot-config-v2");
const { composeRpcUrls } = require("./rpc-url-list");
const { assertTimerSec } = require("./timer-bounds");
const { chainCacheTag } = require("./cache-store");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");

const {
  parsePositiveInt,
  parseTimerSec,
  parseBoundedSetting,
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,
  PRIVATE_KEY,
  DRY_RUN,
  VERBOSE,
  PORT,
  HOST,
} = runtimeFlags;

/*- Shipped app-runtime defaults, merged with any operator override at
 *  `app-config/user-configurable/app-runtime.json`.  Loaded once at
 *  module init; used below as the env-var-fallback expression in every
 *  consumer so no numeric/string default is literally written in this
 *  file. */
const APP_CONFIG = loadMergedDefaults("app-runtime.json");

/*-
 *  Single-source baseline for every Bot-Setting default value, used
 *  below as the env-var-fallback expression in every
 *  `parseBoundedSetting` / `parseTimerSec` call site, so no numeric
 *  default is ever literally written in this file.
 *
 *  Read through the reader that vets, rather than `loadMergedDefaults`
 *  directly: it holds each value to its range in setting-bounds.json,
 *  so an out-of-range or non-numeric override never travels on as a
 *  live setting.  Reading the merged JSON raw takes the same file with
 *  none of that.
 *
 *  The STRICT variant, because this is startup.  A setting an operator
 *  wrote outside its range stops the app here, naming it, rather than
 *  being replaced by a number nobody chose — and startup is the only
 *  place that can refuse, since the lenient reader is what a poll cycle
 *  and an HTTP route call.  See docs/engineering.md § "Reading
 *  Configuration Values".
 */
const _BOT_DEFAULTS = readBotConfigDefaultsStrict();

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
const REBALANCE_OOR_THRESHOLD_PCT = parseBoundedSetting(
  process.env.REBALANCE_OOR_THRESHOLD_PCT,
  _BOT_DEFAULTS.rebalanceOutOfRangeThresholdPercent,
  "REBALANCE_OOR_THRESHOLD_PCT",
  "rebalanceOutOfRangeThresholdPercent",
);

/** Minutes of continuous OOR before auto-rebalance (0 = disabled). */
const REBALANCE_TIMEOUT_MIN = parseBoundedSetting(
  process.env.REBALANCE_TIMEOUT_MIN,
  _BOT_DEFAULTS.rebalanceTimeoutMin,
  "REBALANCE_TIMEOUT_MIN",
  "rebalanceTimeoutMin",
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

/*-
 *  Seconds before a stuck TX is cancelled with a zero-value self-transfer.
 *  DERIVED from `deadlineSec × cancelToDeadlineMultiple` (both in
 *  app-runtime.json) so the two values can't drift.  The environment
 *  override still wins if operators need to force a specific value.
 */
const TX_CANCEL_SEC = parseTimerSec(
  process.env.TX_CANCEL_SEC,
  DEADLINE_SEC * APP_CONFIG.tx.cancelToDeadlineMultiple,
  "TX_CANCEL_SEC",
  "txCancelSec",
);

/**
 * Read one of app-runtime.json's timers, which nothing in `.env`
 * overrides, and check it as every timer setting is checked.
 *
 * The bound is taken from the shipped value, so an operator's override
 * may reach 1000 times it, never past the 48 hours `src/timer-bounds.js`
 * allows anything. Seconds or milliseconds as the key's name says.
 *
 * @param {string} group  The setting's group in app-runtime.json.
 * @param {string} key    The setting's name in that group.
 * @returns {number} The configured value.
 * @throws {Error} When the value cannot be a timer delay.
 */
function _runtimeTimer(group, key) {
  try {
    return assertTimerSec({
      sec: APP_CONFIG[group]?.[key],
      key,
      defaultSec: loadShippedDefaults("app-runtime.json")[group]?.[key],
      label: `app-runtime.json → ${group}.${key}`,
      remedy: "Correct it there, or in its override, and restart.",
    });
  } catch (err) {
    throw new Error(`[config] ${err.message}`, { cause: err });
  }
}

/**
 * Read one of app-runtime.json's other checked settings, held to its
 * range in setting-bounds.json at the same path. Refused at startup
 * rather than replaced: a value nobody chose would run the bot on a
 * schedule or limit the operator does not expect.
 *
 * @param {string} group  The setting's group in app-runtime.json.
 * @param {string} key    The setting's name in that group.
 * @returns {number} The configured value.
 * @throws {Error} When the value lies outside its range.
 */
function _runtimeBounded(group, key) {
  const n = APP_CONFIG[group]?.[key];
  const bound = SETTING_BOUNDS[group][key];
  if (withinBound(n, bound)) return n;
  throw new Error(
    `[config] app-runtime.json → ${group}.${key} must be ` +
      `${boundText(bound)}; it is ${JSON.stringify(n)}.`,
  );
}

/*-
 *  The least time a sped-up transaction gets to confirm before the
 *  cancel goes out, even when sending the speed-up used up the rest of
 *  TX_CANCEL_SEC. Seconds.
 */
const TX_CANCEL_PHASE_FLOOR_SEC = _runtimeTimer("tx", "cancelPhaseFloorSec");

/*-
 *  How a send that failed for a passing reason is retried: this many
 *  times, waiting the base delay before the first retry and one more
 *  base delay before each after it. The `_sendRetries_comment` beside
 *  the values in app-runtime.json explains them.
 */
const TX_SEND_RETRY_BASE_DELAY_MS = _runtimeTimer("tx", "sendRetryBaseDelayMs");
const TX_SEND_RETRIES = _runtimeBounded("tx", "sendRetries");

/*-
 *  How a rebalance is retried after the price moved under it: a first
 *  wait, doubling with each try up to the most it may wait. The
 *  `_swapBackoff_comment` beside the values in app-runtime.json
 *  explains them.
 */
const SWAP_BACKOFF_BASE_MS = _runtimeBounded("tx", "swapBackoffBaseMs");
const SWAP_BACKOFF_MAX_MS = _runtimeBounded("tx", "swapBackoffMaxMs");

/*-
 *  How many times a rebalance left mid-way, its coins in the wallet, is
 *  tried again before the bot stops and asks the operator to act.
 */
const MIDWAY_RETRY_LIMIT = _runtimeBounded("tx", "midwayRetryLimit");

/*-
 *  How soon the bot looks again after a rebalance, compound or cancel,
 *  so the dashboard shows the result; and how often it checks whether a
 *  position's lifetime figures need their scan run again.
 */
const POLL_AFTER_ACTION_MS = _runtimeTimer("poll", "afterActionMs");
const LIFETIME_RESCAN_CHECK_MS = _runtimeTimer("poll", "lifetimeRescanCheckMs");

/*-
 *  How long a managed position may sit drained, with no rebalance in
 *  flight, before the bot stops managing it.
 */
const DRAINED_RETIRE_MS = _runtimeBounded("retire", "drainedAfterMs");

/** How often the bot checks the on-chain position, in seconds. */
const CHECK_INTERVAL_SEC = parseTimerSec(
  process.env.CHECK_INTERVAL_SEC,
  _BOT_DEFAULTS.checkIntervalSec,
  "CHECK_INTERVAL_SEC",
  "checkIntervalSec",
);

/** Minimum time that must elapse between two rebalances, in minutes. */
const MIN_REBALANCE_INTERVAL_MIN = parseBoundedSetting(
  process.env.MIN_REBALANCE_INTERVAL_MIN,
  _BOT_DEFAULTS.minRebalanceIntervalMin,
  "MIN_REBALANCE_INTERVAL_MIN",
  "minRebalanceIntervalMin",
);

/** Maximum rebalances per liquidity pool within a single 24-hour window. */
const MAX_REBALANCES_PER_DAY = parseBoundedSetting(
  process.env.MAX_REBALANCES_PER_DAY,
  _BOT_DEFAULTS.maxRebalancesPerDay,
  "MAX_REBALANCES_PER_DAY",
  "maxRebalancesPerDay",
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
const IMPERMANENT_LOSS_GUARD_PCT = parseBoundedSetting(
  process.env.IMPERMANENT_LOSS_GUARD_PCT,
  _BOT_DEFAULTS.impermanentLossGuardPct,
  "IMPERMANENT_LOSS_GUARD_PCT",
  "impermanentLossGuardPct",
);

/*-
 *  The dashboard settings the server sends, read here once, at startup,
 *  by the strict reader: a value an operator wrote outside its rule stops
 *  the app, naming it. Every later read of them returns this answer
 *  (src/ui-defaults.js), the one `GET /api/ui-defaults` sends the page.
 */
const _UI_SETTINGS = readUiDefaultsStrict();

/*-
 *  How often the dashboard polls `GET /api/status`, for server-side
 *  timing that depends on "the dashboard has had a chance to poll": the
 *  very value the page is sent, so the two cannot disagree.
 */
const DASHBOARD_POLL_INTERVAL_MS = _UI_SETTINGS.dashboardPollIntervalMs;

/**
 * Read how long after a server-side state change the dashboard can be
 * assumed to have POLLED at least once and captured it: the poll
 * interval times `dashboard.pollsBeforeAssumedSeen` in app-runtime.json,
 * whose comment explains the figure.
 *
 * Used by `bot-loop.js`'s re-open-failure path to delay the auto-retire,
 * so the dashboard sees `rebalancePaused=true` and raises its alert
 * before the state is deleted on retire. The result becomes a timer, so
 * the multiple is held to its range in setting-bounds.json, which gives
 * the reason for it.
 *
 * @returns {number} Whole milliseconds.
 * @throws {Error} When the multiple is outside that range.
 */
function _guaranteedDashboardHasPolledMs() {
  const polls = APP_CONFIG.dashboard?.pollsBeforeAssumedSeen;
  const bound = SETTING_BOUNDS.dashboard.pollsBeforeAssumedSeen;
  if (withinBound(polls, bound))
    return Math.round(DASHBOARD_POLL_INTERVAL_MS * polls);
  throw new Error(
    "[config] app-runtime.json → dashboard.pollsBeforeAssumedSeen must be " +
      `${boundText(bound)}; it is ${JSON.stringify(polls)}.`,
  );
}

const GUARANTEED_DASHBOARD_HAS_POLLED_MS = _guaranteedDashboardHasPolledMs();

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

/**
 * Read how long after a drain a re-deposit on the same NFT still counts as
 * a reposition rather than a compound; the compounder turns it into the
 * active chain's blocks. No fallback: an unusable value would quietly
 * count repositions as compounded fees.
 *
 * @returns {number} Seconds.
 * @throws {Error} When the configured value is not a positive number.
 */
function _repositionWindowSec() {
  const sec = APP_CONFIG.compound?.repositionWindowSec;
  if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return sec;
  throw new Error(
    "[config] app-runtime.json → compound.repositionWindowSec must be a " +
      `positive number of seconds; it is ${JSON.stringify(sec)}.`,
  );
}

const COMPOUND_REPOSITION_WINDOW_SEC = _repositionWindowSec();

/*-
 *  The least time between two automatic compounds of one position: this
 *  many polls, and never less than this many seconds. A spacing nobody
 *  chose would compound more often, or less, than the operator expects.
 */
const COMPOUND_AUTO_SPACING_POLLS = _runtimeBounded(
  "compound",
  "autoSpacingPolls",
);
const COMPOUND_AUTO_SPACING_FLOOR_SEC = _runtimeBounded(
  "compound",
  "autoSpacingFloorSec",
);

// ── Contracts ──────────────────────────────────────────────────────────────────

/**
 * Read one of the active chain's contract addresses: `.env` when it names
 * one, else the chain's own entry in chains.json.
 *
 * There is deliberately no third fallback. A chain whose entry leaves an
 * address empty stops the app here, naming the setting, rather than
 * running against another chain's contract: an address is a contract only
 * on the chain it was deployed to. On the testnet, mainnet's addresses
 * hold no code at all.
 *
 * @param {string} envName   The `.env` override's name.
 * @param {*} fromChain      The value in the active chain's entry.
 * @param {string} jsonPath  Where in the chain's entry it lives.
 * @returns {string}
 * @throws {Error} When neither source names an address.
 */
function _chainContract(envName, fromChain, jsonPath) {
  const addr = process.env[envName] || fromChain;
  if (typeof addr === "string" && addr.length > 0) return addr;
  throw new Error(
    `[config] No ${envName} for ${CHAIN_NAME}: set chains.json → ` +
      `${CHAIN_NAME}.${jsonPath}, or ${envName} in .env.`,
  );
}

/** NonfungiblePositionManager contract address on the active chain. */
const POSITION_MANAGER = _chainContract(
  "POSITION_MANAGER",
  CHAIN.contracts?.positionManager?.address,
  "contracts.positionManager.address",
);

/** V3 factory contract address on the active chain. */
const FACTORY = _chainContract(
  "FACTORY",
  CHAIN.contracts?.factory,
  "contracts.factory",
);

/** V3 SwapRouter contract address on the active chain. */
const SWAP_ROUTER = _chainContract(
  "SWAP_ROUTER",
  CHAIN.contracts?.swapRouter?.address,
  "contracts.swapRouter.address",
);

/**
 * Read the name the active chain's entry gives one of its swap routes,
 * which is what the "Routing through:" badge and the Rebalance Events
 * table show.
 *
 * Like an address, a name has no fallback. A route the entry does not
 * name stops startup here, naming the setting, rather than appearing
 * under a name the code chose.
 *
 * @param {*} name           The value in the active chain's entry.
 * @param {string} jsonPath  Where in the chain's entry it lives.
 * @returns {string}
 * @throws {Error} When the entry gives no name.
 */
function _routeName(name, jsonPath) {
  if (typeof name === "string" && name.length > 0) return name;
  throw new Error(
    `[config] No swap route name for ${CHAIN_NAME}: set chains.json → ` +
      `${CHAIN_NAME}.${jsonPath}.`,
  );
}

/** How a swap through the active chain's V3 SwapRouter is named. */
const SWAP_ROUTER_NAME = _routeName(
  CHAIN.contracts?.swapRouter?.name,
  "contracts.swapRouter.name",
);

/**
 * Read the base url of the active chain's swap aggregator, the primary
 * swap path: `AGGREGATOR_URL` in `.env` when it names one, else the
 * chain's own entry, chain path included.
 *
 * The entry must say one way or the other. An empty url means the chain
 * has no aggregator, and every swap goes through the V3 router. A
 * missing one stops startup here rather than being read as that.
 *
 * @returns {string} The url, or "" on a chain with no aggregator.
 * @throws {Error} When the chain's entry gives no url, not even "".
 */
function _aggregatorUrl() {
  const fromEnv = process.env.AGGREGATOR_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const url = CHAIN.aggregator?.url;
  if (typeof url === "string") return url;
  throw new Error(
    `[config] No aggregator url for ${CHAIN_NAME}: set chains.json → ` +
      `${CHAIN_NAME}.aggregator.url, or set it to "" for a chain with none.`,
  );
}

/** Base url of the active chain's swap aggregator; "" when it has none. */
const AGGREGATOR_URL = _aggregatorUrl();

/**
 * Read how a swap through the active chain's aggregator is named.
 *
 * A chain with no aggregator has no such swap, so an empty name is
 * accepted there, as long as the entry gives one. Anywhere else the
 * name is required.
 *
 * @returns {string}
 * @throws {Error} When a name is required and the entry gives none.
 */
function _aggregatorName() {
  const name = CHAIN.aggregator?.name;
  if (AGGREGATOR_URL.length === 0 && name === "") return name;
  return _routeName(name, "aggregator.name");
}

/** How a swap through the active chain's aggregator is named. */
const AGGREGATOR_NAME = _aggregatorName();

// ── Chain description ──────────────────────────────────────────────────────────

/**
 * Check one of the settings describing the active chain in chains.json.
 *
 * None has a fallback. What the app says or computes about a chain — its
 * name, its block time, its native token, its price services, the tag its
 * caches carry — comes from that chain's own entry, so an entry that
 * leaves one out stops startup here, naming the setting, rather than the
 * app filling it in with some other chain's. Consumers read the checked
 * values from `config.CHAIN`.
 *
 * @param {string} jsonPath   Where in the chain's entry it lives.
 * @param {Function} isValid  Whether a value is usable.
 * @param {string} what       What a usable value is, for the message.
 * @throws {Error} When the value is not usable.
 */
function _checkChainSetting(jsonPath, isValid, what) {
  const value = jsonPath.split(".").reduce((node, key) => node?.[key], CHAIN);
  if (isValid(value)) return;
  throw new Error(
    `[config] chains.json → ${CHAIN_NAME}.${jsonPath} must be ${what}; ` +
      `it is ${JSON.stringify(value)}.`,
  );
}

const _isText = (v) => typeof v === "string" && v.length > 0;
const _isString = (v) => typeof v === "string";
const _isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const _isCount = (v) => Number.isInteger(v) && v > 0;

_checkChainSetting(
  "displayName",
  _isText,
  "the chain's name as people read it",
);
_checkChainSetting("homepage", _isText, "the chain's website");
_checkChainSetting("logo", _isText, "the file name of its logo under public/");
_checkChainSetting(
  "blockTimeSec",
  (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  "the chain's average seconds per block",
);
_checkChainSetting(
  "nativeCurrencySymbol",
  _isText,
  "the symbol of the chain's native token",
);
_checkChainSetting(
  "nativeWrappedToken",
  _isString,
  'the address of its wrapped native token, or "" where it has none',
);
for (const service of [
  "dexScreenerChain",
  "geckoTerminalNetwork",
  "moralisChain",
]) {
  _checkChainSetting(
    `priceServices.${service}`,
    _isString,
    `the chain's id at that price service, or "" where it has none`,
  );
}
/*-
 *  The cache tag's own rules (its form, and that no other chain shares
 *  it) live with the cache names it heads; asked here so a bad one stops
 *  startup rather than the first cache write.
 */
chainCacheTag(CHAIN_NAME);

/*-
 *  How transactions on this chain are priced and bounded. Every send
 *  reads these, so none may be missing: a gas limit or price multiplied
 *  by `undefined` is NaN, which ethers refuses only once a rebalance is
 *  already under way.
 */
for (const key of [
  "gasPriceMultiplier",
  "gasLimitMultiplier",
  "speedUpGasBump",
  "cancelGasBump",
])
  _checkChainSetting(key, _isPositive, "a positive number");
// The gas floor under every liquidity removal and every mint.
_checkChainSetting(
  "contracts.positionManager.mintGasLimit",
  _isCount,
  "a positive whole number of gas units",
);
// The gas floor under every other send that does not name its own.
_checkChainSetting(
  "gasLimitFloor",
  _isCount,
  "a positive whole number of gas units",
);
// The gas a whole rebalance is assumed to use, priced before it starts.
_checkChainSetting(
  "estimatedRebalanceGasUnits",
  _isCount,
  "a positive whole number of gas units",
);
/*-
 *  The swap gas gate prices every swap, the V3 router's included, at this
 *  estimate, so it is needed whether or not the chain has an aggregator.
 */
_checkChainSetting(
  "aggregator.estimatedSwapGasUnits",
  _isCount,
  "a positive whole number of gas units",
);

/**
 * Read one of the active chain's aggregator timers, in milliseconds.
 *
 * The value becomes a timer, so `src/timer-bounds.js` decides whether it
 * is usable, as it does for every other timer setting, and an unusable
 * one stops startup with the setting named. Unlike those, nothing in
 * `.env` overrides it, which is why this does not go through
 * `parseTimerSec`: that function's message sends the operator to `.env`.
 * The value stands as its own default, so the bound that applies is the
 * 48-hour ceiling.
 *
 * @param {string} key  The setting's name in the chain's aggregator block.
 * @returns {number} Milliseconds, as configured.
 * @throws {Error} When the configured value cannot be a timer delay.
 */
function _aggregatorMs(key) {
  const ms = CHAIN.aggregator?.[key];
  try {
    return assertTimerSec({
      sec: ms,
      key: `aggregator${key[0].toUpperCase()}${key.slice(1)}`,
      defaultSec: ms,
      label: `chains.json → ${CHAIN_NAME}.aggregator.${key}`,
      remedy:
        "Correct it there, or in its override under " +
        "app-config/user-configurable/, and restart.",
    });
  } catch (err) {
    throw new Error(`[config] ${err.message}`, { cause: err });
  }
}

/*-
 *  Milliseconds a swap waits for the aggregator's quote before counting
 *  it as failed and swapping in the position's own pool instead. The
 *  `_quoteTimeoutMs_comment` beside the value in chains.json explains the
 *  figure.
 */
const AGGREGATOR_QUOTE_TIMEOUT_MS = _aggregatorMs("quoteTimeoutMs");

/*-
 *  The rest of the aggregator block is read by every swap sent through
 *  it, and only then, so it is required where there is an aggregator.
 *  Missing, each fails silently and expensively: no `waitMs` cancels
 *  every swap a millisecond after it is sent, no `cancelGasMultiplier`
 *  leaves a stuck nonce uncancelled, and no `maxAttempts` never tries
 *  the aggregator at all.
 */
if (AGGREGATOR_URL.length > 0) {
  _aggregatorMs("waitMs");
  for (const key of ["gasPriceMultiplier", "cancelGasMultiplier"])
    _checkChainSetting(`aggregator.${key}`, _isPositive, "a positive number");
  _checkChainSetting("aggregator.maxAttempts", _isCount, "a positive count");
  _checkChainSetting(
    "aggregator.gasUnitsWhenQuoteOmitsGas",
    _isCount,
    "a positive whole number of gas units",
  );
}

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
  TX_SPEEDUP_SEC,
  DEADLINE_SEC,
  TX_CANCEL_SEC,
  TX_CANCEL_PHASE_FLOOR_SEC,
  TX_SEND_RETRIES,
  TX_SEND_RETRY_BASE_DELAY_MS,
  CHECK_INTERVAL_SEC,
  MIN_REBALANCE_INTERVAL_MIN,
  MAX_REBALANCES_PER_DAY,
  IMPERMANENT_LOSS_GUARD_PCT,
  REBALANCE_RETRY_SWAP_LIMIT,
  SWAP_BACKOFF_BASE_MS,
  SWAP_BACKOFF_MAX_MS,
  MIDWAY_RETRY_LIMIT,
  POLL_AFTER_ACTION_MS,
  LIFETIME_RESCAN_CHECK_MS,
  DRAINED_RETIRE_MS,
  DASHBOARD_POLL_INTERVAL_MS,
  GUARANTEED_DASHBOARD_HAS_POLLED_MS,
  LOG_FILE,

  // Contracts
  POSITION_MANAGER,
  FACTORY,
  SWAP_ROUTER,
  SWAP_ROUTER_NAME,
  AGGREGATOR_URL,
  AGGREGATOR_NAME,
  AGGREGATOR_QUOTE_TIMEOUT_MS,

  // Per-blockchain
  CHAIN,
  CHAIN_NAME,
  TX_TYPE,

  // Compound
  COMPOUND_MIN_FEE_USD: APP_CONFIG.compound.minFeeUsd,
  COMPOUND_AUTO_SPACING_POLLS,
  COMPOUND_AUTO_SPACING_FLOOR_SEC,
  COMPOUND_DEFAULT_THRESHOLD_USD: APP_CONFIG.compound.defaultThresholdUsd,
  COMPOUND_REPOSITION_WINDOW_SEC,

  // Re-scan Prices dialog: how long the button waits before it is
  // handed back.  Bounds the dialog, not the scan.
  RESCAN_PRICES_TIMEOUT_MS: APP_CONFIG.rescanPrices.timeoutMs,

  // Helpers
  assertLiveModeReady,
  VERBOSE,

  // Internals exposed for testing
  _parsePositiveInt: parsePositiveInt,
};
