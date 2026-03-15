/**
 * @file wallet.js
 * @module wallet
 * @description
 * Software wallet management for the 9mm v3 position manager.
 * Handles three wallet-loading paths:
 *   1. **Generate** – create a brand-new HD wallet with a 12-word BIP-39 mnemonic.
 *   2. **Seed phrase** – derive a wallet from an existing 12- or 24-word mnemonic
 *      with an optional custom derivation path.
 *   3. **Private key** – import a raw 64-hex-char private key directly.
 *
 * The module exposes pure functions that accept an `ethersLib` parameter so
 * that it can be unit-tested by injecting a mock without needing a real
 * blockchain connection.
 *
 * Security notes
 * ──────────────
 * • Private keys and mnemonics are held only in memory; nothing is persisted
 *   to localStorage, sessionStorage, or any network endpoint.
 * • This module deliberately does NOT import ethers globally — callers must
 *   pass the library reference to avoid implicit globals.
 *
 * @example
 * import { generateWallet, walletFromSeed, walletFromKey } from './wallet.js';
 * import * as ethers from 'ethers';
 *
 * const w = generateWallet(ethers);
 * console.log(w.address, w.mnemonic);
 */

'use strict';

/**
 * @typedef {Object} WalletData
 * @property {string}      address     Checksummed Ethereum/PulseChain address.
 * @property {string}      privateKey  Hex-encoded private key (with 0x prefix).
 * @property {string|null} mnemonic    BIP-39 mnemonic phrase, or null if not applicable.
 * @property {'generated'|'seed'|'key'} source  How this wallet was loaded.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}    valid    True if the input is acceptable.
 * @property {string}     message  Human-readable status message.
 * @property {WalletData|null} wallet  Populated on success, null on failure.
 */

/** Default BIP-44 derivation path for EVM chains. */
const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0/0";

/**
 * Generate a brand-new random HD wallet.
 * @param {object} ethersLib  The ethers.js library object.
 * @returns {WalletData}
 * @throws {Error} If ethers fails to generate entropy.
 */
function generateWallet(ethersLib) {
  const w = ethersLib.Wallet.createRandom();
  return {
    address:    w.address,
    privateKey: w.privateKey,
    mnemonic:   w.mnemonic.phrase,
    source:     'generated',
  };
}

/**
 * Validate and derive a wallet from a BIP-39 mnemonic phrase.
 * @param {object} ethersLib         The ethers.js library object.
 * @param {string} phrase            Space-separated word list (12 or 24 words).
 * @param {string} [derivationPath]  HD derivation path. Defaults to m/44'/60'/0'/0/0.
 * @returns {ValidationResult}
 */
function walletFromSeed(ethersLib, phrase, derivationPath) {
  const path  = (derivationPath || DEFAULT_DERIVATION_PATH).trim();
  const words = phrase.trim().split(/\s+/);

  if (words.length !== 12 && words.length !== 24) {
    return {
      valid:   false,
      message: `Expected 12 or 24 words, got ${words.length}.`,
      wallet:  null,
    };
  }

  try {
    const w = ethersLib.HDNodeWallet.fromPhrase(phrase.trim(), undefined, path);
    return {
      valid:   true,
      message: '✓ Valid seed phrase',
      wallet:  {
        address:    w.address,
        privateKey: w.privateKey,
        mnemonic:   phrase.trim(),
        source:     'seed',
      },
    };
  } catch (err) {
    return {
      valid:   false,
      message: `Invalid seed phrase: ${err.message.slice(0, 80)}`,
      wallet:  null,
    };
  }
}

/**
 * Validate and import a wallet from a raw private key.
 * @param {object} ethersLib  The ethers.js library object.
 * @param {string} rawKey     Hex private key, with or without 0x prefix.
 * @returns {ValidationResult}
 */
function walletFromKey(ethersLib, rawKey) {
  const hex = rawKey.trim().startsWith('0x')
    ? rawKey.trim().slice(2)
    : rawKey.trim();

  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return {
      valid:   false,
      message: `Invalid private key — expected 64 hex characters, got ${hex.length}.`,
      wallet:  null,
    };
  }

  try {
    const w = new ethersLib.Wallet('0x' + hex);
    return {
      valid:   true,
      message: '✓ Valid private key',
      wallet:  {
        address:    w.address,
        privateKey: '0x' + hex,
        mnemonic:   null,
        source:     'key',
      },
    };
  } catch (err) {
    return {
      valid:   false,
      message: `Key error: ${err.message.slice(0, 80)}`,
      wallet:  null,
    };
  }
}

/**
 * Return a short display string for a wallet address.
 * @param {string} address  Full checksummed address.
 * @returns {string}  e.g. "0xAbCd…ef12"
 */
function shortAddress(address) {
  if (!address || address.length < 12) return address || '';
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Return a human-readable label for the wallet source.
 * @param {'generated'|'seed'|'key'} source
 * @returns {string}
 */
function sourceLabel(source) {
  switch (source) {
    case 'generated': return 'GENERATED';
    case 'seed':      return 'SEED IMPORT';
    case 'key':       return 'KEY IMPORT';
    default:          return 'UNKNOWN';
  }
}

/**
 * Check if an address has on-chain transaction history.
 * Uses `getTransactionCount` (nonce) — a wallet that has sent at least one
 * transaction will have count > 0.  This avoids false positives from
 * balance-only checks (a wallet could have zero balance after use).
 * Returns false on network error (cannot confirm = treat as unknown).
 *
 * @param {object} provider  An ethers-compatible provider with `getTransactionCount`.
 * @param {string} address   Checksummed Ethereum/PulseChain address.
 * @returns {Promise<boolean>}  True if the address has sent at least one transaction.
 */
async function hasOnChainActivity(provider, address) {
  try {
    const txCount = await provider.getTransactionCount(address);
    return txCount > 0;
  } catch {
    return false;
  }
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  generateWallet,
  walletFromSeed,
  walletFromKey,
  shortAddress,
  sourceLabel,
  hasOnChainActivity,
  DEFAULT_DERIVATION_PATH,
};
