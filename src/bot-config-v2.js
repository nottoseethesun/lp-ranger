/**
 * @file src/bot-config-v2.js
 * @module bot-config-v2
 * @description
 * Load, save, and migrate `.bot-config.json` for multi-position management.
 *
 * V2 structure:
 *   { version: 2,
 *     global: { slippagePct, checkIntervalSec, … },
 *     managedPositions: [ compositeKey, … ],
 *     positions: { [compositeKey]: { status, thresholdPct, … } } }
 *
 * V1 (no `version` field) is a flat object with all keys at the top level.
 * On first load the flat structure is migrated: global keys move to `global`,
 * position-specific keys move to `positions[activePositionId]`, and the
 * original is backed up as `.bot-config.v1.json`.
 *
 * Focus is entirely client-side (determined by the URL in each browser tab),
 * so there is no `focusedPositionKey` in the config.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = '.bot-config.json';
const BACKUP_FILE = '.bot-config.v1.json';

/** Keys that belong in the global section. */
const GLOBAL_KEYS = [
  'slippagePct', 'checkIntervalSec',
  'minRebalanceIntervalMin', 'maxRebalancesPerDay',
  'gasStrategy', 'triggerType',
];

/** Keys that belong in a per-position section. */
const POSITION_KEYS = [
  'rebalanceOutOfRangeThresholdPercent', 'rebalanceTimeoutMin',
  'pnlEpochs', 'hodlBaseline', 'residuals',
  'collectedFeesUsd', 'initialDepositUsd',
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
  const { getAddress } = require('ethers');
  const w = wallet && wallet.startsWith('0x') ? getAddress(wallet) : wallet;
  const c = contract && contract.startsWith('0x') ? getAddress(contract) : contract;
  return `${blockchain}-${w}-${c}-${tokenId}`;
}

/**
 * Parse a composite key back into its components.
 * Returns null if the key format is invalid.
 * @param {string} key
 * @returns {{ blockchain: string, wallet: string, contract: string, tokenId: string }|null}
 */
function parseCompositeKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split('-');
  if (parts.length !== 4 || !parts[1].startsWith('0x') || !parts[2].startsWith('0x')) return null;
  return { blockchain: parts[0], wallet: parts[1], contract: parts[2], tokenId: parts[3] };
}

/**
 * Resolve the config file path.
 * @param {string} [dir]  Directory override (default: cwd).
 * @returns {string}
 */
function _configPath(dir) { return path.join(dir || process.cwd(), CONFIG_FILE); }

/**
 * Migrate a v1 flat config to v2 structure.
 * @param {object} v1       Parsed v1 config (flat keys).
 * @param {string} [dir]    Directory for backup file.
 * @returns {object}        V2 config object.
 */
function migrateV1toV2(v1, dir) {
  // Back up original
  try {
    const backupPath = path.join(dir || process.cwd(), BACKUP_FILE);
    fs.writeFileSync(backupPath, JSON.stringify(v1, null, 2), 'utf8');
    console.log('[config] Backed up v1 config to %s', BACKUP_FILE);
  } catch (err) {
    console.warn('[config] Could not back up v1 config:', err.message);
  }

  const global = {};
  const positionData = {};

  for (const key of GLOBAL_KEYS) {
    if (v1[key] !== undefined) global[key] = v1[key];
  }
  for (const key of POSITION_KEYS) {
    if (v1[key] !== undefined) positionData[key] = v1[key];
  }

  const activeId = v1.activePositionId ? String(v1.activePositionId) : null;
  const managedPositions = [];
  const positions = {};

  if (activeId) {
    // Use a placeholder composite key — the full key (with blockchain/wallet/contract)
    // will be resolved on first bot startup when position detection runs.
    const placeholderKey = `pulsechain-unknown-unknown-${activeId}`;
    positionData.status = 'running';
    positions[placeholderKey] = positionData;
    managedPositions.push(placeholderKey);
  }

  console.log('[config] Migrated v1 → v2 (managed: %d positions)', managedPositions.length);

  return { version: 2, global, managedPositions, positions };
}

/**
 * Load bot config from disk.  Auto-migrates v1 to v2 on first load.
 * @param {string} [dir]  Directory override (default: cwd).
 * @returns {object}       V2 config (or empty v2 structure if no file).
 */
function loadConfig(dir) {
  const filePath = _configPath(dir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { version: 2, global: {}, managedPositions: [], positions: {} };
  }

  if (raw.version === 2) return raw;

  // No version field → v1, migrate
  const v2 = migrateV1toV2(raw, dir);
  saveConfig(v2, dir);
  return v2;
}

/**
 * Save bot config to disk.
 * @param {object} cfg   V2 config object.
 * @param {string} [dir] Directory override.
 */
function saveConfig(cfg, dir) {
  try {
    fs.writeFileSync(_configPath(dir), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.warn('[config] Could not save bot config:', err.message);
  }
}

/**
 * Get or create a position's config section.
 * @param {object} cfg          V2 config object.
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
 * @param {object} cfg          V2 config object.
 * @param {string} positionKey  Composite key.
 * @param {string} [status]     Initial status (default: 'running').
 */
function addManagedPosition(cfg, positionKey, status) {
  if (!cfg.managedPositions.includes(positionKey)) {
    cfg.managedPositions.push(positionKey);
  }
  const pos = getPositionConfig(cfg, positionKey);
  pos.status = status || 'running';
}

/**
 * Remove a position from the managed set (keeps config for history).
 * @param {object} cfg          V2 config object.
 * @param {string} positionKey  Composite key.
 */
function removeManagedPosition(cfg, positionKey) {
  cfg.managedPositions = cfg.managedPositions.filter((k) => k !== positionKey);
  if (cfg.positions[positionKey]) {
    cfg.positions[positionKey].status = 'stopped';
  }
}

/**
 * Update a position's composite key after rebalance (tokenId changes).
 * Carries over all config, P&L epochs, HODL baseline, and residuals.
 * @param {object} cfg     V2 config object.
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
  cfg.managedPositions = cfg.managedPositions.map((k) => k === oldKey ? newKey : k);
}

/**
 * Read a config value for a position, falling back to global.
 * Single lookup path — no copies, no sync.
 * @param {object} cfg           V2 config object (source of truth).
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
  migrateV1toV2,
  GLOBAL_KEYS,
  POSITION_KEYS,
};
