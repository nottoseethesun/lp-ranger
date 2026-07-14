/**
 * @file src/bot-config-v2.js
 * @module bot-config-v2
 * @description
 * Load and save `app-config/user-configurable/bot-config.json` for
 * multi-position management.
 *
 * Structure:
 *   { global: { slippagePct, checkIntervalSec, … },
 *     positions: { [compositeKey]: { status, thresholdPct, … } } }
 *
 * The `positions` object is the single source of truth.
 * Managed positions are derived: any key with
 * status 'running'.  Status semantics:
 *   - 'running' → actively managed, auto-start on restart
 *   - 'stopped' (or absent) → unmanaged, data kept for history
 *
 * Focus is entirely client-side (determined by the URL
 * in each browser tab).
 *
 * Storage location: `app-config/user-configurable/bot-config.json`
 * (gitignored). See the `app-config/` section of server.js for the full
 * layout. Tests pass a `dir` override to `loadConfig(dir)` /
 * `saveConfig(cfg, dir)` and write directly to `${dir}/bot-config.json`,
 * bypassing the app-config/user-configurable/ prefix.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

/** Default directory that holds the runtime bot config file. */
const APP_CONFIG_DIR = path.join(
  process.cwd(),
  "app-config",
  "user-configurable",
);
const CONFIG_FILE = "bot-config.json";

/** Keys that belong in the global section. */
const GLOBAL_KEYS = [
  "triggerType",
  "positionManager",
  "factory",
  "rpcUrl",
  "approvalMultiple",
  /*-
   *  Maximum gas cost as a percentage of swap value before the gas gate
   *  trips (see `src/swap-gates.js`).  Single global knob shared by all
   *  three swap call sites: initial Rebalance, corrective Rebalance,
   *  Compound.  Stored as a percent (e.g. `1` = 1%); UI bounds 0.1–15.
   *  Default in `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`.
   */
  "gasFeePct",
  /*-
   *  Price-source cache TTL in milliseconds for `src/price-fetcher.js`
   *  (the in-memory cache that backs `fetchTokenPriceUsd`).  Read once
   *  per process at module-load time (no live reload — restart to
   *  apply).  Default `120000` (2 min).  See the idle-driven price-
   *  lookup pause section in docs/architecture.md for context.
   */
  "priceCacheTtlMs",
  /*-
   *  Multiplier that derives `_DUST_UNIT_PRICE_TTL_MS` from
   *  `priceCacheTtlMs` (`dust = price * multiplier`).  Default `30`
   *  reproduces the original 1-h dust-unit-price cache when paired with
   *  the 120000 ms price TTL default (120000 * 30 = 3_600_000 ms).
   *  Must be a positive integer >= 1; a runtime assertion at module
   *  load guards the integer-multiple invariant.
   */
  "dustUnitPriceCacheMultiplier",
  /*-
   *  Cache TTL while inside a `withFreshPricesAllowed` scope
   *  (rebalance/compound).  Default `4000` ms (4 s).  Replaces the
   *  earlier "bypass cache + dedup entirely in-move" behaviour that
   *  caused the rapid-fire burst when multiple rebalance stages each
   *  called `fetchTokenPriceUsd` for the same token within a few
   *  seconds (4-6 source hits per token per move).  See
   *  `src/price-fetcher-gate.js#inMove`.
   */
  "moveCacheTtlMs",
  /*-
   *  Balanced-band Telegram notifier (`src/telegram-notifications/balanced-notifier.js`):
   *  multiplier on `CHECK_INTERVAL_SEC` for the cadence at which the
   *  notifier fetches fresh USD prices to evaluate the ±5% balanced
   *  condition.  Default `10` → fetch every 10× poll interval (50 min
   *  at the default 300 s poll).  Only consulted when the
   *  `positionBalanced` Telegram event is enabled — otherwise zero
   *  load.  See `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`
   *  `_pricePauseExceptionPollWindowMultiple_comment` for operator
   *  guidance.
   */
  "pricePauseExceptionPollWindowMultiple",
];

/** Keys that belong in a per-position (per-pool) section. */
const POSITION_KEYS = [
  "rebalanceOutOfRangeThresholdPercent",
  "rebalanceTimeoutMin",
  /*-
   * Persistent per-position override for the rebalance range width, in
   * percent of current price.  When set, every subsequent rebalance
   * (manual OR automatic) uses this width via `_computeRange()` in
   * src/rebalancer.js.  When unset, the bot falls back to
   * `rangeMath.preserveRange()` (existing default — preserves the
   * on-chain tick spread).  No shipped default literal per
   * feedback_one_literal_per_shipped_default; empty === use fallback.
   * Set from the "Range Width" input in the Range & Execution
   * subsection of Bot Settings (see public/dashboard-throttle.js
   * `saveRangeWidth`).  Cleared by POSTing `null` — the null-sweep in
   * src/server-routes.js POST /api/config handler deletes the key from
   * disk so bot-config.json stays clean.
   */
  "rebalanceRangeWidthPct",
  "slippagePct",
  "checkIntervalSec",
  "minRebalanceIntervalMin",
  "maxRebalancesPerDay",
  "gasStrategy",
  "hodlBaseline",
  "residuals",
  "collectedFeesUsd",
  "initialDepositUsd",
  "priceOverride0",
  "priceOverride1",
  "priceOverrideForce",
  "autoCompoundEnabled",
  "autoCompoundThresholdUsd",
  "compoundHistory",
  "totalCompoundedUsd",
  /*-
   *  Per-NFT total gas wei (mint TX gas + standalone compound TX gas) keyed
   *  by tokenId.  Populated by the lifetime scan and the on-demand per-NFT
   *  backfill in `bot-pnl-updater._currentNftGasUsd`.  Drives the Current
   *  panel's "Gas" row so Managed and Unmanaged report the same figure for
   *  the same NFT.  Lifetime panel still uses the per-epoch tracker sum;
   *  this field is Current-panel only.
   */
  "nftGasWeiByTokenId",
  /*-
   *  Per-NFT standalone-compound USD (sum of per-event usdValue) keyed by
   *  tokenId.  Populated by the same backfill scan that fills
   *  nftGasWeiByTokenId.  Drives the Managed Current panel's "Fees
   *  Compounded" row when compoundHistory lacks entries for this NFT
   *  (e.g. the unmanaged scan ran first and the bot's lifetime scan was
   *  gated off by `hasCompoundData`).  Current-panel only.
   */
  "nftCompoundedUsdByTokenId",
  "lastCompoundAt",
  "offsetToken0Pct",
  /*-
   *  Lifetime deposit (USD) and the "fallback price source was used" flag
   *  produced by `computeDepositUsd` in `bot-hodl-scan.js`.  Persisted so
   *  that the disk-as-source-of-truth gate in `_scanLifetimePoolData` can
   *  read them on the next bot start and skip a redundant deposit
   *  recompute — a stale `lastNftScanBlock` would otherwise replay an
   *  incremental NFT scan, miss earlier `IncreaseLiquidity` events, and
   *  overwrite the correct lifetime deposit with a partial smaller total.
   */
  "totalLifetimeDepositUsd",
  "depositUsedFallback",
];

/**
 * Build a composite key from URL-style components.
 * Format: `blockchain-wallet-contract-tokenId` (dash-separated).
 * @param {string} blockchain  e.g. 'pulsechain'
 * @param {string} wallet      Checksummed wallet address.
 * @param {string} contract    NFT contract address.
 * @param {string} tokenId     NFT token ID.
 * @returns {string}
 */
function compositeKey(blockchain, wallet, contract, tokenId) {
  const w = wallet && wallet.startsWith("0x") ? getAddress(wallet) : wallet;
  const c =
    contract && contract.startsWith("0x") ? getAddress(contract) : contract;
  return `${blockchain}-${w}-${c}-${tokenId}`;
}

/**
 * Parse a composite key back into its components.
 * Returns null if the key format is invalid.
 * @param {string} key
 * @returns {{ blockchain: string, wallet: string, contract: string, tokenId: string }|null}
 */
function parseCompositeKey(key) {
  if (!key || typeof key !== "string") return null;
  const parts = key.split("-");
  if (
    parts.length !== 4 ||
    !parts[1].startsWith("0x") ||
    !parts[2].startsWith("0x")
  )
    return null;
  return {
    blockchain: parts[0],
    wallet: parts[1],
    contract: parts[2],
    tokenId: parts[3],
  };
}

/**
 * Resolve the config file path.
 * Production calls `loadConfig()` / `saveConfig(cfg)` with no `dir` — the
 * file resolves to `<cwd>/app-config/user-configurable/bot-config.json`.
 * Tests pass an explicit `dir = tmpDir()` and get `${dir}/bot-config.json`.
 * @param {string} [dir]  Directory override (default:
 *                        `app-config/user-configurable/`).
 * @returns {string}
 */
function _configPath(dir) {
  return path.join(dir || APP_CONFIG_DIR, CONFIG_FILE);
}

/** @private Empty config structure. */
function _empty() {
  return { global: {}, positions: {} };
}

/**
 * Load bot config from disk.
 * @param {string} [dir]  Directory override (default: cwd).
 * @returns {object}       Config object (or empty structure if no file).
 */
function loadConfig(dir) {
  const filePath = _configPath(dir);
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (!text || text.trim().length === 0) {
      log.warn("[config] loadConfig: file exists but is EMPTY — %s", filePath);
      return _empty();
    }
    const raw = JSON.parse(text);
    const posCount = Object.keys(raw.positions || {}).length;
    const managed = Object.values(raw.positions || {}).filter(
      (p) => p.status === "running",
    ).length;
    log.info(
      "[config] loadConfig: %d positions (%d running) from %s (%d bytes)",
      posCount,
      managed,
      filePath,
      text.length,
    );
    // Backup on load — safety net for config stomping investigation
    if (posCount > 0) {
      try {
        fs.copyFileSync(filePath, filePath.replace(".json", ".backup.json"));
      } catch {
        /* best-effort */
      }
    }
    const cfg = {
      global: raw.global || {},
      positions: raw.positions || {},
    };
    _purgePhantomEntries(cfg);
    return cfg;
  } catch (err) {
    log.info(
      "[config] loadConfig: no file or parse error — starting empty (%s)",
      err.message,
    );
    return _empty();
  }
}

/**
 * Remove phantom managed-position stubs left on disk by prior runs.
 *
 * Phantom signature: `status === "running"` AND the entry has EXACTLY
 * one key (`"status"`).  Legitimate entries always carry additional
 * fields (`hodlBaseline`, `autoCompoundEnabled`, settings overrides,
 * etc.) — by the time a position is started, `_persistPositionConfig`
 * has at minimum written `nftGasWeiByTokenId` or similar.
 *
 * Phantoms are produced by the bug fixed in this PR: a stale composite
 * key written by `handleManage` after a key migration during force-
 * rebalance.  This purge heals any existing `bot-config.json` that
 * carries a phantom from before the fix shipped.
 *
 * Conservative — never touches an entry with any field besides status
 * (no false positives possible for a legitimately-running position).
 *
 * @param {object} cfg  Mutated in place.
 */
function _purgePhantomEntries(cfg) {
  if (!cfg || !cfg.positions) return;
  const removed = [];
  for (const [key, pos] of Object.entries(cfg.positions)) {
    if (!pos || pos.status !== "running") continue;
    const fields = Object.keys(pos);
    if (fields.length === 1 && fields[0] === "status") {
      delete cfg.positions[key];
      removed.push(key);
    }
  }
  if (removed.length > 0) {
    log.warn(
      "[config] Purged %d phantom managed-position stub(s) (status=running, no other fields): %s",
      removed.length,
      removed.join(", "),
    );
  }
}

/**
 * Save bot config to disk.
 * @param {object} cfg   Config object.
 * @param {string} [dir] Directory override.
 */
/** Read disk config for guard comparison. */
function _readDiskConfig(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const pos = raw.positions || {};
    return {
      count: Object.keys(pos).length,
      running: Object.values(pos).filter((p) => p.status === "running").length,
      positions: pos,
    };
  } catch {
    return { count: 0, running: 0, positions: {} };
  }
}

/**
 * Guard: refuse to write if running positions would silently vanish.
 * Returns true if the save should be blocked.
 */
function _guardRunningPositions(cfg, disk) {
  const lost = Object.entries(disk.positions).filter(
    ([k, v]) =>
      v.status === "running" && cfg.positions[k]?.status !== "running",
  );
  const unexplained = lost.filter(
    ([k]) => !cfg.positions[k] || cfg.positions[k].status === undefined,
  );
  if (unexplained.length === 0) return false;
  log.warn(
    "[config] saveConfig: REFUSING — %d running positions would vanish:",
    unexplained.length,
  );
  for (const [k] of unexplained) log.warn("[config]   LOST: %s", k);
  log.warn("[config]   caller=%s", new Error().stack?.split("\n")[3]?.trim());
  return true;
}

function saveConfig(cfg, dir) {
  delete cfg.version; // strip legacy field if present
  delete cfg.managedPositions; // strip obsolete field
  const posKeys = Object.keys(cfg.positions || {});
  const running = posKeys.filter(
    (k) => cfg.positions[k]?.status === "running",
  ).length;
  const filePath = _configPath(dir);
  const disk = _readDiskConfig(filePath);
  // Refuse to overwrite a non-empty config with an empty one
  if (posKeys.length === 0 && disk.count > 0 && !dir) {
    log.warn(
      "[config] saveConfig: REFUSING to overwrite %d positions with empty config",
      disk.count,
    );
    return;
  }
  // Refuse to reduce running count unless positions were explicitly stopped
  if (running < disk.running && !dir && _guardRunningPositions(cfg, disk))
    return;
  // ── Diagnostic logging ─────────────────────────────────────────────────
  const caller = new Error().stack?.split("\n")[2]?.trim() || "";
  if (posKeys.length < disk.count)
    log.warn(
      "[config] saveConfig: position count DECREASED %d → %d caller=%s",
      disk.count,
      posKeys.length,
      caller,
    );
  else
    log.info(
      "[config] saveConfig: %d positions (%d running) caller=%s",
      posKeys.length,
      running,
      caller,
    );
  for (const k of posKeys) {
    const v = cfg.positions[k];
    log.info(
      "[config]   %s status=%s keys=%s",
      k,
      v.status || "—",
      Object.keys(v).join(","),
    );
  }
  // ── Atomic write ───────────────────────────────────────────────────────
  // Ensure the parent directory exists (e.g. app-config/user-configurable/ on first run
  // after a fresh install, or a test tmp dir that hasn't been populated).
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    log.warn("[config] Could not save bot config:", err.message);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* tmp cleanup */
    }
  }
}

/**
 * Return composite keys of all managed positions.
 * Managed = any position whose status is not 'stopped'.
 * @param {object} cfg  Config object.
 * @returns {string[]}
 */
function managedKeys(cfg) {
  return Object.keys(cfg.positions).filter(
    (k) => cfg.positions[k].status === "running",
  );
}

/**
 * Look up a position's config section WITHOUT creating it.  Returns the
 * mutable reference when present, or `null` when the slot is absent.
 *
 * Use this for all read/update sites.  Lazy-create was the source of
 * the phantom-key bug: a stale composite key passed in after a key
 * migration would auto-create an empty slot under the now-dead old
 * tokenId, leaving a `{ status: "running" }`-only stub that the
 * dashboard's `isPositionManaged` then treated as a live managed
 * position forever.  Callers that legitimately need to create a fresh
 * slot (handleManage's first-time creation, addManagedPosition's
 * status flip) use `getOrCreatePositionConfig` explicitly.
 *
 * @param {object} cfg          Config object.
 * @param {string} positionKey  Composite key.
 * @returns {object|null}       Mutable reference, or null if missing.
 */
function getPositionConfig(cfg, positionKey) {
  return cfg.positions[positionKey] || null;
}

/**
 * Look up a position's config section, creating an empty slot if
 * absent.  Sole legitimate callers are `addManagedPosition` (which
 * flips `status="running"` immediately after) and `handleManage`'s
 * first-time fresh-position creation path.  ANY other caller should
 * use the non-lazy `getPositionConfig` to avoid resurrecting phantoms.
 *
 * @param {object} cfg          Config object.
 * @param {string} positionKey  Composite key.
 * @returns {object}            Mutable reference to position config.
 */
function getOrCreatePositionConfig(cfg, positionKey) {
  if (!cfg.positions[positionKey]) {
    cfg.positions[positionKey] = {};
  }
  return cfg.positions[positionKey];
}

/**
 * Add a position to the managed set.
 * @param {object} cfg          Config object.
 * @param {string} positionKey  Composite key.
 * @param {string} [status]     Initial status (default: 'running').
 */
function addManagedPosition(cfg, positionKey) {
  const pos = getOrCreatePositionConfig(cfg, positionKey);
  const prev = pos.status;
  pos.status = "running";
  log.info(
    "[config] addManagedPosition %s (was %s → running)",
    positionKey.slice(-10),
    prev || "undefined",
  );
}

/**
 * Remove a position from management (keeps config for history).
 * @param {object} cfg          Config object.
 * @param {string} positionKey  Composite key.
 */
function removeManagedPosition(cfg, positionKey) {
  if (cfg.positions[positionKey]) {
    log.info(
      "[config] removeManagedPosition %s (was %s → stopped)",
      positionKey.slice(-10),
      cfg.positions[positionKey].status || "undefined",
    );
    cfg.positions[positionKey].status = "stopped";
  }
}

/**
 * Update a position's composite key after rebalance (tokenId changes).
 * Carries over all config, HODL baseline, and residuals.
 * @param {object} cfg     Config object.
 * @param {string} oldKey  Previous composite key.
 * @param {string} newKey  New composite key.
 */
function migratePositionKey(cfg, oldKey, newKey) {
  if (oldKey === newKey) return;
  const data = cfg.positions[oldKey];
  if (data) {
    cfg.positions[newKey] = data;
    delete cfg.positions[oldKey];
  }
}

/**
 * Read a config value for a position, falling back to global.
 * Single lookup path — no copies, no sync.
 * @param {object} cfg           Config object (source of truth).
 * @param {string} positionKey   Composite key.
 * @param {string} key           Config key to read.
 * @returns {*}  The value, or undefined if not set in either scope.
 */
function readConfigValue(cfg, positionKey, key) {
  const pos = cfg.positions[positionKey];
  if (pos && pos[key] !== undefined) return pos[key];
  if (cfg.global[key] !== undefined) return cfg.global[key];
  return undefined;
}

module.exports = {
  compositeKey,
  parseCompositeKey,
  loadConfig,
  saveConfig,
  getPositionConfig,
  getOrCreatePositionConfig,
  readConfigValue,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey,
  managedKeys,
  GLOBAL_KEYS,
  POSITION_KEYS,
};
