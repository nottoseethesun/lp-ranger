/**
 * @file wallet-manager.js
 * @module walletManager
 * @description
 * Server-side wallet state for the LP Ranger dashboard.
 * Stores the wallet's private key and optional mnemonic encrypted using
 * AES-256-GCM with a user-supplied session password.  The encrypted state
 * is persisted to `wallet.json` so it survives server restarts.  The
 * plaintext key is never held in server memory except during the brief
 * encrypt/decrypt window, and never appears in the persisted file.
 *
 * A save is all or nothing: the whole file goes to `wallet.json.tmp`,
 * flushed to disk, and is then renamed over `wallet.json`, so a save that
 * fails or is cut short leaves the wallet file as it was. When
 * `wallet.json` is found missing, empty or damaged, as a crash or a faulty
 * file system can leave it, and `wallet.json.tmp` holds a whole wallet,
 * the wallet is recovered from it, without the operator doing anything.
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

const { log } = require("./log");
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
// Production default is app-config/user-configurable/wallet.json — see the
// app-config/ section of server.js for the full layout.
const _WALLET_FILE =
  process.env.WALLET_FILE_PATH ||
  path.join(process.cwd(), "app-config", "user-configurable", "wallet.json");

// Where a save writes first, renamed over the wallet file once whole.
const _TMP_FILE = `${_WALLET_FILE}.tmp`;

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

/**
 * Write a wallet to app-config/user-configurable/wallet.json (encrypted —
 * no plaintext secrets), all or nothing: the whole file goes to
 * wallet.json.tmp, flushed to disk, then is renamed over wallet.json. A
 * write that fails removes what it left of the temp file before it
 * throws, so wallet.json is as it was.
 * @param {{address: string, source: string, hasMnemonic: boolean,
 *   encrypted: object}} wallet  What the file holds, as `_state` does.
 */
function _saveToDisk(wallet) {
  const data = {
    address: wallet.address,
    source: wallet.source,
    hasMnemonic: wallet.hasMnemonic,
    encrypted: wallet.encrypted,
  };
  // Ensure parent dir exists (e.g. app-config/ on first run).
  fs.mkdirSync(path.dirname(_WALLET_FILE), { recursive: true });
  try {
    fs.writeFileSync(_TMP_FILE, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flush: true,
    });
    fs.renameSync(_TMP_FILE, _WALLET_FILE);
  } catch (err) {
    _removeTmpFile();
    throw err;
  }
  log.info(
    "[wallet] Saved %s (%d bytes, exists=%s)",
    path.relative(process.cwd(), _WALLET_FILE),
    JSON.stringify(data).length,
    fs.existsSync(_WALLET_FILE),
  );
}

/** Remove wallet.json.tmp, if there is one to remove. */
function _removeTmpFile() {
  try {
    fs.unlinkSync(_TMP_FILE);
  } catch {
    /* nothing to remove */
  }
}

/**
 * Remove app-config/user-configurable/wallet.json from disk, and the temp
 * file beside it, so a cleared wallet cannot be recovered from it.
 */
function _removeFromDisk() {
  log.warn(
    "[wallet] Deleting app-config/user-configurable/wallet.json — stack:",
    new Error().stack,
  );
  try {
    fs.unlinkSync(_WALLET_FILE);
  } catch {
    /* file may not exist */
  }
  _removeTmpFile();
}

/**
 * The wallet a file holds, or null when the file is missing, empty or
 * holds no wallet.
 * @param {string} file
 * @returns {object|null}
 */
function _readWalletFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && raw.address && raw.encrypted ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Put the wallet in wallet.json.tmp back as wallet.json, when wallet.json
 * holds none; a warning names it. Should the rename fail, the wallet is
 * still loaded from the temp file, and the next save puts the file right.
 * @param {object} wallet  The wallet the temp file holds.
 * @returns {object} The same wallet.
 */
function _recoverFromTmpFile(wallet) {
  try {
    fs.renameSync(_TMP_FILE, _WALLET_FILE);
    log.warn(
      "[wallet] wallet.json was missing, empty or damaged: recovered the wallet from wallet.json.tmp, the whole copy a save writes first",
    );
  } catch (err) {
    log.warn(
      "[wallet] wallet.json was missing, empty or damaged: loaded the wallet from wallet.json.tmp, which could not be renamed back (%s)",
      err.message,
    );
  }
  return wallet;
}

/**
 * Load _state from wallet.json. Without a wallet there and with a whole
 * one in wallet.json.tmp, the wallet is recovered from the temp file. A
 * temp file beside a good wallet.json, or one holding no wallet, is what
 * a save cut short left, and is removed.
 */
function _loadFromDisk() {
  let raw = _readWalletFile(_WALLET_FILE);
  const fromTmp = raw === null ? _readWalletFile(_TMP_FILE) : null;
  if (fromTmp !== null) raw = _recoverFromTmpFile(fromTmp);
  else if (fs.existsSync(_TMP_FILE)) {
    _removeTmpFile();
    log.info("[wallet] Removed wallet.json.tmp, left by a save cut short");
  }
  if (raw === null) return;
  _state.address = raw.address;
  _state.source = raw.source || "key";
  _state.hasMnemonic = !!raw.hasMnemonic;
  _state.encrypted = raw.encrypted;
}

// Load persisted wallet on module init
_loadFromDisk();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Import a wallet: encrypt its secrets, write them to wallet.json, then
 * hold them in memory. A write that fails (a full disk, a read-only
 * folder) throws with the wallet in memory as it was, so the key the bot
 * holds still belongs to the wallet loaded.
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

  const wallet = {
    address,
    source: source || "key",
    hasMnemonic: !!mnemonic,
    encrypted: {
      saltHex: salt.toString("hex"),
      ivHex: iv.toString("hex"),
      authTagHex: cipher.getAuthTag().toString("hex"),
      ciphertextHex: encrypted.toString("hex"),
    },
  };
  _saveToDisk(wallet);
  Object.assign(_state, wallet);
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

/**
 * Forget the wallet in memory and read it from disk again, as a fresh
 * start does (tests only).
 */
function _reloadFromDiskForTests() {
  _state.address = null;
  _state.source = null;
  _state.hasMnemonic = false;
  _state.encrypted = null;
  _loadFromDisk();
}

module.exports = {
  importWallet,
  revealWallet,
  getStatus,
  clearWallet,
  getAddress,
  hasWallet,
  _reloadFromDiskForTests,
};
