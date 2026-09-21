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
const os = require("os");
const path = require("path");
const { getAddress } = require("ethers");
const { RETIRED_POSITION_KEYS } = require("./bot-config-keys");

const CONFIG_FILE = "bot-config.json";

/*-
 *  Per-process sandbox standing in for the operator's config directory
 *  while tests run. Created on first use, so a run that never touches an
 *  undirected path creates nothing.
 */
let _testConfigDir = null;

/**
 * @private Directory holding the runtime bot config file.
 *
 * Under `node --test` this is a sandbox, not the operator's directory.
 * Node sets `NODE_TEST_CONTEXT` in every test worker, so the redirect
 * cannot be forgotten the way a per-file one can: a test that reaches
 * this path is one that did not ask for a directory, and no test wants
 * the operator's own config — the ones that need a config pass an
 * explicit `dir`, and `scripts/check.js` only has to back the real file
 * up because writes used to land on it.
 *
 * Resolved per call rather than once at load, so the answer cannot be
 * fixed before a test process has identified itself. Production is
 * unaffected: `NODE_TEST_CONTEXT` is undefined and `process.cwd()` does
 * not move, so this returns what the module constant always did.
 *
 * @returns {string}
 */
function _appConfigDir() {
  if (process.env.NODE_TEST_CONTEXT === undefined)
    return path.join(process.cwd(), "app-config", "user-configurable");
  if (_testConfigDir === null)
    _testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lp-ranger-test-config-"),
    );
  return _testConfigDir;
}

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
  return path.join(dir || _appConfigDir(), CONFIG_FILE);
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
 * A phantom is a stale composite key: `handleManage` writes the key it
 * was called with, and a force-rebalance that migrates the key in
 * between leaves the old one behind carrying nothing but its status.
 * An on-disk file may already hold one, so the purge runs on load.
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
 * Drop every `RETIRED_POSITION_KEYS` entry from every position slot.
 *
 * Runs on the save path rather than the load path so the file is cleaned
 * exactly once per write, and so a slot the app never touches is still
 * cleaned the next time anything saves.
 *
 * **Never strips a slot down to its status alone.** That is the phantom
 * signature `_purgePhantomEntries` deletes on the next load, and the
 * position would stop being managed with nothing said — the operator
 * restarts and finds it gone. The purge calls itself conservative
 * because "legitimate entries always carry additional fields"; a strip
 * that removes the last of those fields is what would make that false,
 * so the strip is what gives way. The key stays in that one slot,
 * unread by anything, and goes on the next save that leaves the slot
 * with real content — which is any save that follows an operator
 * setting or a persisted figure.
 *
 * @param {object} cfg  Config object, mutated in place.
 */
function _stripRetiredKeys(cfg) {
  for (const slot of Object.values(cfg.positions || {})) {
    if (slot === undefined || slot === null) continue;
    const retired = RETIRED_POSITION_KEYS.filter((k) => k in slot);
    if (retired.length === 0) continue;
    const keeping = Object.keys(slot).filter((k) => !retired.includes(k));
    if (keeping.length === 1 && keeping[0] === "status") continue;
    for (const key of retired) delete slot[key];
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
  _stripRetiredKeys(cfg);
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
 * Read a single value from the `global` section, quietly.
 *
 * Deliberately NOT `loadConfig`: this runs during module initialisation
 * of `src/config.js`, before logging is meaningful and on every import
 * including every test, so it must not log, must not warn, and must not
 * throw.  Any problem reading the file means "not set".
 * @param {string} key    Global setting name.
 * @param {string} [dir]  Directory override (default: app-config dir).
 * @returns {*}  The value, or undefined when unset or unreadable.
 */
function readGlobalSetting(key, dir) {
  try {
    const text = fs.readFileSync(_configPath(dir), "utf8");
    if (!text || text.trim().length === 0) return undefined;
    const raw = JSON.parse(text);
    const v = raw && raw.global ? raw.global[key] : undefined;
    return v === null ? undefined : v;
  } catch {
    /*- Absent, empty or malformed config is a normal first-run state,
     *  not an error worth surfacing.  Callers treat undefined as "the
     *  operator has not set this", which is exactly right. */
    return undefined;
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
  readGlobalSetting,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey,
  managedKeys,
};
