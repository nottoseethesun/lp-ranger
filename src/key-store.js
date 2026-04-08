/**
 * @file key-store.js
 * @module keyStore
 * @description
 * Encrypted private-key storage for the 9mm v3 Position Manager.
 *
 * Encrypts a private key with a user-supplied password using AES-256-GCM
 * and PBKDF2 key derivation.  The encrypted payload is saved as a JSON file
 * on disk so the user does not need to keep the raw private key in `.env`.
 *
 * Encryption details
 * ──────────────────
 *   - Key derivation: PBKDF2-SHA-512, 600 000 iterations, 32-byte key
 *   - Cipher: AES-256-GCM (authenticated encryption)
 *   - Random 16-byte salt and 12-byte IV per encryption
 *   - Auth tag stored alongside ciphertext
 *
 * File format (JSON)
 * ──────────────────
 *   {
 *     "version": 1,
 *     "kdf": "pbkdf2",
 *     "kdfParams": { "digest": "sha512", "iterations": 600000, "saltHex": "…" },
 *     "cipher": "aes-256-gcm",
 *     "ivHex": "…",
 *     "authTagHex": "…",
 *     "ciphertextHex": "…"
 *   }
 *
 * WARNING
 * ───────
 * If you lose your password, the encrypted key file CANNOT be recovered.
 * There is no password reset mechanism.  You will need to re-enter your
 * private key or seed phrase to create a new encrypted key file.
 * Keep a secure backup of your private key or seed phrase independently.
 *
 * Usage
 * ─────
 *   const { encryptAndSave, loadAndDecrypt } = require('./key-store');
 *
 *   // Save:
 *   await encryptAndSave('0xABC…', 'my-password', './keyfile.json');
 *
 *   // Load:
 *   const privateKey = await loadAndDecrypt('my-password', './keyfile.json');
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────────────────

/** Current file format version. */
const _FORMAT_VERSION = 1;

/** PBKDF2 iteration count (OWASP 2023 recommendation for SHA-512). */
const _PBKDF2_ITERATIONS = 600_000;

/** PBKDF2 digest algorithm. */
const _PBKDF2_DIGEST = "sha512";

/** Salt length in bytes. */
const _SALT_BYTES = 16;

/** Derived key length in bytes (256 bits for AES-256). */
const _KEY_BYTES = 32;

/** AES-GCM IV length in bytes (96 bits per NIST recommendation). */
const _IV_BYTES = 12;

/** Cipher algorithm. */
const _CIPHER = "aes-256-gcm";

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Derive an encryption key from a password and salt via PBKDF2.
 * @param {string} password  User-supplied password.
 * @param {Buffer} salt      Random salt.
 * @returns {Promise<Buffer>} 32-byte derived key.
 */
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
 * Encrypt a plaintext string with AES-256-GCM.
 * @param {string} plaintext  Data to encrypt.
 * @param {Buffer} key        32-byte encryption key.
 * @returns {{ ivHex: string, authTagHex: string, ciphertextHex: string }}
 */
function _encrypt(plaintext, key) {
  const iv = crypto.randomBytes(_IV_BYTES);
  const cipher = crypto.createCipheriv(_CIPHER, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ivHex: iv.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
    ciphertextHex: encrypted.toString("hex"),
  };
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 * @param {string} ciphertextHex  Hex-encoded ciphertext.
 * @param {Buffer} key            32-byte encryption key.
 * @param {string} ivHex          Hex-encoded IV.
 * @param {string} authTagHex     Hex-encoded auth tag.
 * @returns {string} Decrypted plaintext.
 */
function _decrypt(ciphertextHex, key, ivHex, authTagHex) {
  const decipher = crypto.createDecipheriv(
    _CIPHER,
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a private key and save to a JSON file.
 *
 * @param {string} privateKey  Hex private key (with or without 0x prefix).
 * @param {string} password    Encryption password (must be non-empty).
 * @param {string} filePath    Output file path.
 * @returns {Promise<void>}
 * @throws {Error} If privateKey or password is empty.
 */
async function encryptAndSave(privateKey, password, filePath) {
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error("privateKey must be a non-empty string");
  }
  if (!password || typeof password !== "string") {
    throw new Error("password must be a non-empty string");
  }

  const salt = crypto.randomBytes(_SALT_BYTES);
  const key = await _deriveKey(password, salt);
  const { ivHex, authTagHex, ciphertextHex } = _encrypt(privateKey, key);

  const payload = {
    version: _FORMAT_VERSION,
    kdf: "pbkdf2",
    kdfParams: {
      digest: _PBKDF2_DIGEST,
      iterations: _PBKDF2_ITERATIONS,
      saltHex: salt.toString("hex"),
    },
    cipher: _CIPHER,
    ivHex,
    authTagHex,
    ciphertextHex,
  };

  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2));
}

/**
 * Load an encrypted key file and decrypt with a password.
 *
 * @param {string} password  Decryption password.
 * @param {string} filePath  Path to the encrypted key file.
 * @returns {Promise<string>} Decrypted private key.
 * @throws {Error} If the file is missing, corrupt, or the password is wrong.
 */
async function loadAndDecrypt(password, filePath) {
  if (!password || typeof password !== "string") {
    throw new Error("password must be a non-empty string");
  }

  const resolved = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`Key file not found: ${resolved}`, { cause: err });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error("Key file is not valid JSON", { cause: err });
  }

  if (payload.version !== _FORMAT_VERSION) {
    throw new Error(`Unsupported key file version: ${payload.version}`);
  }

  const salt = Buffer.from(payload.kdfParams.saltHex, "hex");
  const iterations = payload.kdfParams.iterations || _PBKDF2_ITERATIONS;
  const digest = payload.kdfParams.digest || _PBKDF2_DIGEST;

  const key = await new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, _KEY_BYTES, digest, (err, k) =>
      err ? reject(err) : resolve(k),
    );
  });

  try {
    return _decrypt(
      payload.ciphertextHex,
      key,
      payload.ivHex,
      payload.authTagHex,
    );
  } catch (err) {
    throw new Error("Decryption failed — wrong password or corrupted file", {
      cause: err,
    });
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  encryptAndSave,
  loadAndDecrypt,
  _deriveKey,
  _encrypt,
  _decrypt,
  _FORMAT_VERSION,
  _PBKDF2_ITERATIONS,
};
