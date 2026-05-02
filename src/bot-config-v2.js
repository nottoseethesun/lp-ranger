/**
 * @file src/bot-config-v2.js
 * @module bot-config-v2
 * @description
 * Load and save `app-config/.bot-config.json` for multi-position management.
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
 * Storage location: `app-config/.bot-config.json` (gitignored). See the
 * `app-config/` section of server.js for the full layout. Tests pass a
 * `dir` override to `loadConfig(dir)` / `saveConfig(cfg, dir)` and write
 * directly to `${dir}/.bot-config.json`, bypassing the app-config/ prefix.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

/** Default directory that holds the runtime bot config file. */
const APP_CONFIG_DIR = path.join(process.cwd(), "app-config");
const CONFIG_FILE = ".bot-config.json";

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
   *  Default in `app-config/static-tunables/bot-config-defaults.json`.
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
   *  Balanced-band Telegram notifier (`src/balanced-notifier.js`):
   *  multiplier on `CHECK_INTERVAL_SEC` for the cadence at which the
   *  notifier fetches fresh USD prices to evaluate the ±5% balanced
   *  condition.  Default `10` → fetch every 10× poll interval (10 min
   *  at the default 60 s poll).  Only consulted when the
   *  `positionBalanced` Telegram event is enabled — otherwise zero
   *  load.  See `app-config/static-tunables/bot-config-defaults.json`
   *  `_pricePauseExceptionPollWindowMultiple_comment` for operator
   *  guidance.
   */
  "pricePauseExceptionPollWindowMultiple",
];

/** Keys that belong in a per-position (per-pool) section. */
const POSITION_KEYS = [
  "rebalanceOutOfRangeThresholdPercent",
  "rebalanceTimeoutMin",
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
 * file resolves to `<cwd>/app-config/.bot-config.json`. Tests pass an
 * explicit `dir = tmpDir()` and get `${dir}/.bot-config.json`.
 * @param {string} [dir]  Directory override (default: `app-config/`).
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
      console.warn(
        "[config] loadConfig: file exists but is EMPTY — %s",
        filePath,
      );
      return _empty();
    }
    const raw = JSON.parse(text);
    const posCount = Object.keys(raw.positions || {}).length;
    const managed = Object.values(raw.positions || {}).filter(
      (p) => p.status === "running",
    ).length;
    console.log(
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
    return {
      global: raw.global || {},
      positions: raw.positions || {},
    };
  } catch (err) {
    console.log(
      "[config] loadConfig: no file or parse error — starting empty (%s)",
      err.message,
    );
    return _empty();
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
  console.warn(
    "[config] saveConfig: REFUSING — %d running positions would vanish:",
    unexplained.length,
  );
  for (const [k] of unexplained) console.warn("[config]   LOST: %s", k);
  console.warn(
    "[config]   caller=%s",
    new Error().stack?.split("\n")[3]?.trim(),
  );
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
    console.warn(
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
    console.warn(
      "[config] saveConfig: position count DECREASED %d → %d caller=%s",
      disk.count,
      posKeys.length,
      caller,
    );
  else
    console.log(
      "[config] saveConfig: %d positions (%d running) caller=%s",
      posKeys.length,
      running,
      caller,
    );
  for (const k of posKeys) {
    const v = cfg.positions[k];
    console.log(
      "[config]   %s status=%s keys=%s",
      k,
      v.status || "—",
      Object.keys(v).join(","),
    );
  }
  // ── Atomic write ───────────────────────────────────────────────────────
  // Ensure the parent directory exists (e.g. app-config/ on first run
  // after a fresh install, or a test tmp dir that hasn't been populated).
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("[config] Could not save bot config:", err.message);
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
 * Get or create a position's config section.
 * @param {object} cfg          Config object.
 * @param {string} positionKey  Composite key.
 * @returns {object}            Mutable reference to position config.
 */
function getPositionConfig(cfg, positionKey) {
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
  const pos = getPositionConfig(cfg, positionKey);
  const prev = pos.status;
  pos.status = "running";
  console.log(
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
    console.log(
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
  readConfigValue,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey,
  managedKeys,
  GLOBAL_KEYS,
  POSITION_KEYS,
};
