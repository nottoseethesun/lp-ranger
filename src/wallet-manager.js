/**
 * @file wallet-manager.js
 * @module walletManager
 * @description
 * Server-side wallet state for the 9mm v3 Position Manager dashboard.
 * Stores the wallet's private key and optional mnemonic encrypted using
 * AES-256-GCM with a user-supplied session password.  The encrypted state
 * is persisted to `.wallet.json` so it survives server restarts.  The
 * plaintext key is never held in server memory except during the brief
 * encrypt/decrypt window, and never appears in the persisted file.
 *
 * Security model
 * ──────────────
 *   - The password is NOT stored — it is used only to derive an encryption key
 *     via PBKDF2 and then discarded.
 *   - The wallet address (public) is stored in the clear for position scanning.
 *   - To reveal the private key, the user must re-enter their password.
 *   - On clearWallet(), all encrypted material is zeroed.
 *
 * Note on seed phrases (BIP-39 mnemonics)
 * ────────────────────────────────────────
 * A mnemonic CANNOT be derived from a private key.  The BIP-39 → BIP-32
 * derivation chain is one-way:  mnemonic → seed → master key → child key.
 * If the user imported via seed phrase or generated a wallet, the mnemonic
 * is stored alongside the key.  If they imported a raw private key, no
 * mnemonic is available.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Crypto constants ────────────────────────────────────────────────────────

const _PBKDF2_ITERATIONS = 600_000;
const _PBKDF2_DIGEST = "sha512";
const _SALT_BYTES = 16;
const _KEY_BYTES = 32;
const _IV_BYTES = 12;
const _CIPHER = "aes-256-gcm";

// ── Persistence ─────────────────────────────────────────────────────────────

// Tests set WALLET_FILE_PATH to a temp file so they don't destroy the real wallet.
// Production default is app-config/.wallet.json — see the app-config/ section
// of server.js for the full layout.
const _WALLET_FILE =
  process.env.WALLET_FILE_PATH ||
  path.join(process.cwd(), "app-config", ".wallet.json");

// ── In-memory state ─────────────────────────────────────────────────────────

const _state = {
  address: null,
  source: null, // 'generated' | 'seed' | 'key'
  hasMnemonic: false,
  encrypted: null, // { saltHex, ivHex, authTagHex, ciphertextHex }
};

// ── Internal helpers ────────────────────────────────────────────────────────

function _deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      _PBKDF2_ITERATIONS,
      _KEY_BYTES,
      _PBKDF2_DIGEST,
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Persist current _state to app-config/.wallet.json (encrypted — no plaintext secrets). */
function _saveToDisk() {
  const data = {
    address: _state.address,
    source: _state.source,
    hasMnemonic: _state.hasMnemonic,
    encrypted: _state.encrypted,
  };
  // Ensure parent dir exists (e.g. app-config/ on first run).
  fs.mkdirSync(path.dirname(_WALLET_FILE), { recursive: true });
  fs.writeFileSync(_WALLET_FILE, JSON.stringify(data, null, 2), "utf8");
  console.log(
    "[wallet] Saved app-config/.wallet.json (%d bytes, exists=%s)",
    JSON.stringify(data).length,
    fs.existsSync(_WALLET_FILE),
  );
}

/** Remove app-config/.wallet.json from disk. */
function _removeFromDisk() {
  console.warn(
    "[wallet] Deleting app-config/.wallet.json — stack:",
    new Error().stack,
  );
  try {
    fs.unlinkSync(_WALLET_FILE);
  } catch {
    /* file may not exist */
  }
}

/** Load _state from .wallet.json if it exists. */
function _loadFromDisk() {
  try {
    if (!fs.existsSync(_WALLET_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(_WALLET_FILE, "utf8"));
    if (raw && raw.address && raw.encrypted) {
      _state.address = raw.address;
      _state.source = raw.source || "key";
      _state.hasMnemonic = !!raw.hasMnemonic;
      _state.encrypted = raw.encrypted;
    }
  } catch {
    /* corrupt file — start fresh */
  }
}

// Load persisted wallet on module init
_loadFromDisk();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Import a wallet: encrypt its secrets and store in memory.
 * @param {object} opts
 * @param {string} opts.address     Checksummed wallet address.
 * @param {string} opts.privateKey  Hex private key (0x-prefixed).
 * @param {string|null} opts.mnemonic  BIP-39 mnemonic, or null.
 * @param {string} opts.source      'generated' | 'seed' | 'key'.
 * @param {string} opts.password    User-chosen session password.
 */
async function importWallet({
  address,
  privateKey,
  mnemonic,
  source,
  password,
}) {
  if (!password || typeof password !== "string") {
    throw new Error("Password is required to protect your wallet");
  }
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error("Private key is required");
  }
  if (!address || typeof address !== "string") {
    throw new Error("Address is required");
  }

  const plaintext = JSON.stringify({
    privateKey,
    mnemonic: mnemonic || null,
  });
  const salt = crypto.randomBytes(_SALT_BYTES);
  const key = await _deriveKey(password, salt);
  const iv = crypto.randomBytes(_IV_BYTES);

  const cipher = crypto.createCipheriv(_CIPHER, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  _state.address = address;
  _state.source = source || "key";
  _state.hasMnemonic = !!mnemonic;
  _state.encrypted = {
    saltHex: salt.toString("hex"),
    ivHex: iv.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
    ciphertextHex: encrypted.toString("hex"),
  };
  _saveToDisk();
}

/**
 * Decrypt and return wallet secrets.  Requires the session password.
 * @param {string} password  The password set during import.
 * @returns {Promise<{privateKey: string, mnemonic: string|null}>}
 * @throws {Error} If no wallet is loaded or the password is wrong.
 */
async function revealWallet(password) {
  if (!_state.encrypted) throw new Error("No wallet loaded");
  if (!password || typeof password !== "string") {
    throw new Error("Password is required");
  }

  const salt = Buffer.from(_state.encrypted.saltHex, "hex");
  const key = await _deriveKey(password, salt);

  try {
    const decipher = crypto.createDecipheriv(
      _CIPHER,
      key,
      Buffer.from(_state.encrypted.ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(_state.encrypted.authTagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(_state.encrypted.ciphertextHex, "hex")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new Error("Wrong password");
  }
}

/**
 * Return wallet status (no secrets).
 * @returns {{ loaded: boolean, address: string|null, source: string|null, hasMnemonic: boolean }}
 */
function getStatus() {
  let fileExists = false;
  try {
    fileExists = fs.existsSync(_WALLET_FILE);
  } catch {
    /* */
  }
  return {
    loaded: !!_state.address,
    address: _state.address,
    source: _state.source,
    hasMnemonic: _state.hasMnemonic,
    fileExists,
  };
}

/** Clear all wallet data from memory and disk. */
function clearWallet() {
  _state.address = null;
  _state.source = null;
  _state.hasMnemonic = false;
  _state.encrypted = null;
  _removeFromDisk();
}

/** @returns {string|null} The wallet address, or null if not loaded. */
function getAddress() {
  return _state.address;
}

/** @returns {boolean} True if a wallet is loaded. */
function hasWallet() {
  return !!_state.address;
}

module.exports = {
  importWallet,
  revealWallet,
  getStatus,
  clearWallet,
  getAddress,
  hasWallet,
};
