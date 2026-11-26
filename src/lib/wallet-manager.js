/**
 * @file wallet-manager.js
 * @module walletManager
 * @description
 * Server-side wallet state for the LP Ranger dashboard.
 * Stores the wallet's private key and optional mnemonic encrypted using
 * AES-256-GCM with a user-supplied session password.  The encrypted state
 * is persisted to `wallet.json` so it survives server restarts.  This
 * module keeps no plaintext key: it holds the encrypted state and the
 * address, and decrypts only when asked (`revealWallet`).  Once a wallet
 * unlocks, the decrypted key is handed to the bot, which keeps it in
 * memory to sign with (`setPrivateKey`, src/bot/bot-interface.js).  The
 * plaintext key never appears in the persisted file.
 *
 * A save is all or nothing: the whole file goes to `wallet.json.tmp`,
 * flushed to disk, given `wallet.json`'s file mode, and is then renamed
 * over `wallet.json`, so a save that fails or is cut short leaves the
 * wallet file as it was, and a mode the operator set (`chmod 600`, say)
 * stays. When `wallet.json` is found missing, empty or damaged, as a crash
 * or a faulty file system can leave it, and `wallet.json.tmp` holds a
 * whole wallet, the wallet is read from that copy, without the operator
 * doing anything.
 *
 * Loading this module only reads. The files are put right by
 * `settleWalletFile`, which only the programs that own the wallet call as
 * they start (src/server.js, src/bot.js, scripts/import-wallet.js): the
 * copy becomes `wallet.json` again, or a copy left beside a good
 * `wallet.json` is removed. A util tool that loads this module, as any
 * that loads src/lib/config.js does, touches neither file, so it can never
 * take a save's copy while the server writes it.
 *
 * Security model
 * ──────────────
 *   - The password is NOT stored — it is used only to derive an encryption key
 *     via PBKDF2 and then discarded.
 *   - The wallet address (public) is stored in the clear for position scanning.
 *   - To reveal the private key, the user must re-enter their password.
 *   - clearWallet() drops the wallet from memory and deletes wallet.json
 *     and its .tmp copy.
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
const { readEnv } = require("./env-settings");
const { makeTestTempFolder } = require("./test-temp-folders");

// ── Crypto constants ────────────────────────────────────────────────────────

const _PBKDF2_ITERATIONS = 600_000;
const _PBKDF2_DIGEST = "sha512";
const _SALT_BYTES = 16;
const _KEY_BYTES = 32;
const _IV_BYTES = 12;
const _CIPHER = "aes-256-gcm";

// ── Persistence ─────────────────────────────────────────────────────────────

// This test process's wallet file, made on first use under `node --test`.
let _testFile = null;

/**
 * Where the wallet is saved: the file `WALLET_FILE_PATH` names, read
 * through `readEnv`; else, under `node --test`, a file in a temp folder of
 * the test process's own, so no test reads or writes the operator's
 * wallet; else app-config/user-configurable/wallet.json in the install
 * ("The app-config Directory" in docs/engineering.md gives the layout). Asked on
 * every read and write. A save writes `<this>.tmp` first.
 * @returns {string}
 */
function walletFilePath() {
  const named = readEnv("WALLET_FILE_PATH");
  if (named !== undefined) return named;
  if (process.env.NODE_TEST_CONTEXT === undefined)
    return path.join(
      process.cwd(),
      "app-config",
      "user-configurable",
      "wallet.json",
    );
  if (_testFile === null)
    _testFile = path.join(makeTestTempFolder("wallet"), "wallet.json");
  return _testFile;
}

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
 * A file's permission bits, or undefined when it cannot be read (no file).
 * @param {string} file
 * @returns {number|undefined}
 */
function _modeOf(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Rename a wallet file's temp copy over it, the copy first given the
 * wallet file's permission bits when there is a wallet file, so the mode
 * the operator set stays. A rename makes the copy the file, and a new copy
 * has the default mode.
 * @param {string} tmp   The temp copy.
 * @param {string} file  The wallet file.
 */
function _renameKeepingMode(tmp, file) {
  const mode = _modeOf(file);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/**
 * Write a wallet to the wallet file (`walletFilePath`), encrypted, with no
 * plaintext secrets, all or nothing: the whole file goes to its `.tmp`
 * copy, flushed to disk, then is renamed over it, keeping its mode. A
 * write that fails removes what it left of the temp file before it throws,
 * so the wallet file is as it was.
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
  const file = walletFilePath();
  const tmp = `${file}.tmp`;
  // Ensure parent dir exists (e.g. app-config/ on first run).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flush: true,
    });
    _renameKeepingMode(tmp, file);
  } catch (err) {
    _removeTmpFile(tmp);
    throw err;
  }
  log.info(
    "[wallet] Saved %s (%d bytes, exists=%s)",
    path.relative(process.cwd(), file),
    JSON.stringify(data).length,
    fs.existsSync(file),
  );
}

/**
 * Remove a wallet file's temp copy, if there is one to remove.
 * @param {string} tmp  The temp copy's path.
 * @returns {boolean} Whether it was removed: false when there was none,
 *   or it could not be (a folder at that path, a read-only folder).
 */
function _removeTmpFile(tmp) {
  try {
    fs.unlinkSync(tmp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the wallet file from disk, and the temp file beside it, so a
 * cleared wallet cannot be recovered from it.
 */
function _removeFromDisk() {
  const file = walletFilePath();
  log.warn(
    "[wallet] Deleting %s — stack:",
    path.relative(process.cwd(), file),
    new Error().stack,
  );
  try {
    fs.unlinkSync(file);
  } catch {
    /* file may not exist */
  }
  _removeTmpFile(`${file}.tmp`);
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
 * Put the copy in wallet.json.tmp back as wallet.json, keeping the broken
 * wallet.json's mode, with a warning saying so. Should the rename fail, the
 * wallet stays loaded from the copy, and the warning says why.
 * @param {string} file  The wallet file, whose `.tmp` copy holds the wallet.
 */
function _recoverFromTmpFile(file) {
  try {
    _renameKeepingMode(`${file}.tmp`, file);
    log.warn(
      "[wallet] wallet.json was missing, empty or damaged: recovered the wallet from wallet.json.tmp, the whole copy a save writes first",
    );
  } catch (err) {
    log.warn(
      "[wallet] wallet.json was missing, empty or damaged: loaded the wallet from wallet.json.tmp, which could not be renamed back (%s)",
      err.message,
    );
  }
}

/**
 * Put the wallet's files right, as a program that owns the wallet starts
 * (src/server.js, src/bot.js, scripts/import-wallet.js), never as this
 * module loads. With no wallet in wallet.json and a whole one in
 * wallet.json.tmp, as a save cut short can leave them, the copy becomes
 * wallet.json again. A copy beside a good wallet.json, or one holding no
 * wallet, is what a save cut short left, and is removed.
 */
function settleWalletFile() {
  const file = walletFilePath();
  const tmp = `${file}.tmp`;
  if (!fs.existsSync(tmp)) return;
  if (_readWalletFile(file) === null && _readWalletFile(tmp) !== null) {
    _recoverFromTmpFile(file);
    return;
  }
  if (_removeTmpFile(tmp))
    log.info("[wallet] Removed wallet.json.tmp, left by a save cut short");
  else
    log.warn(
      "[wallet] Could not remove wallet.json.tmp, left by a save cut short",
    );
}

/**
 * Load _state from wallet.json, reading only. Without a wallet there and
 * with a whole one in wallet.json.tmp, the wallet is read from that copy,
 * which stays where it is until `settleWalletFile` puts it back.
 */
function _loadFromDisk() {
  const file = walletFilePath();
  const raw = _readWalletFile(file) ?? _readWalletFile(`${file}.tmp`);
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
    fileExists = fs.existsSync(walletFilePath());
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
 * Forget the wallet in memory and read it from disk again, as this module
 * does as it loads, reading only (tests only).
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
  walletFilePath,
  settleWalletFile,
  _reloadFromDiskForTests,
};
