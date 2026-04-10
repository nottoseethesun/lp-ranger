/**
 * @file src/api-key-store.js
 * @description Encrypted storage for third-party API keys.
 * Keys are encrypted with the user's wallet password (AES-256-GCM,
 * PBKDF2-SHA512) and persisted to `app-config/api-keys.json`.  Each service
 * gets its own encrypted entry (e.g. `moralisEncrypted`).
 *
 * Storage location: `app-config/api-keys.json` (gitignored). A format
 * template lives at `app-config/api-keys.example.json` (tracked). See the
 * `app-config/` section of server.js for the full layout. Tests can
 * override the path via the `API_KEYS_FILE_PATH` environment variable.
 *
 * File format:
 *   {
 *     "moralisEncrypted": {
 *       "version": 1,
 *       "kdfParams": { "digest": "sha512", "iterations": 600000, "saltHex": "…" },
 *       "ivHex": "…", "authTagHex": "…", "ciphertextHex": "…"
 *     }
 *   }
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  _deriveKey,
  _encrypt,
  _decrypt,
  _FORMAT_VERSION,
  _PBKDF2_ITERATIONS,
} = require("./key-store");

const _FILE =
  process.env.API_KEYS_FILE_PATH ||
  path.join(process.cwd(), "app-config", "api-keys.json");

/** Read the full api-keys.json from disk. */
function _readStore() {
  try {
    return JSON.parse(fs.readFileSync(_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Write the full store to disk (atomic). */
function _writeStore(data) {
  // Ensure parent dir exists (e.g. app-config/ on first run).
  fs.mkdirSync(path.dirname(_FILE), { recursive: true });
  const tmp = _FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, _FILE);
}

/**
 * Encrypt an API key and save it under `{service}Encrypted` in api-keys.json.
 * @param {string} service   Service name (e.g. "moralis").
 * @param {string} apiKey    Plaintext API key.
 * @param {string} password  Wallet password for encryption.
 */
async function saveEncryptedKey(service, apiKey, password) {
  if (!service || !apiKey || !password) {
    throw new Error("service, apiKey, and password are required");
  }
  const salt = crypto.randomBytes(16);
  const key = await _deriveKey(password, salt);
  const encrypted = _encrypt(apiKey, key);
  const entry = {
    version: _FORMAT_VERSION,
    kdfParams: {
      digest: "sha512",
      iterations: _PBKDF2_ITERATIONS,
      saltHex: salt.toString("hex"),
    },
    ...encrypted,
  };
  const store = _readStore();
  store[service + "Encrypted"] = entry;
  _writeStore(store);
}

/**
 * Decrypt an API key from api-keys.json.
 * @param {string} service   Service name (e.g. "moralis").
 * @param {string} password  Wallet password for decryption.
 * @returns {Promise<string|null>} Decrypted key, or null if not found.
 */
async function loadEncryptedKey(service, password) {
  const store = _readStore();
  const entry = store[service + "Encrypted"];
  if (!entry) return null;
  const salt = Buffer.from(entry.kdfParams.saltHex, "hex");
  const key = await _deriveKey(password, salt);
  return _decrypt(entry.ciphertextHex, key, entry.ivHex, entry.authTagHex);
}

/**
 * Check whether an encrypted key exists for a service.
 * @param {string} service  Service name.
 * @returns {boolean}
 */
function hasEncryptedKey(service) {
  const store = _readStore();
  return !!store[service + "Encrypted"];
}

module.exports = { saveEncryptedKey, loadEncryptedKey, hasEncryptedKey };
