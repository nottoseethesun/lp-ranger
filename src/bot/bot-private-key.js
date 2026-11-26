/**
 * @file src/bot/bot-private-key.js
 * @module bot-private-key
 * @description
 * Resolve the bot's signing private key from one of three sources:
 *   1. `PRIVATE_KEY` env var (32-byte hex, validated).
 *   2. Encrypted wallet on disk (`app-config/user-configurable/wallet.json`) decrypted
 *      with `WALLET_PASSWORD` env var or an interactive prompt.
 *   3. Returns `null` when neither source is available — the headless
 *      bot (src/bot.js), its one caller, stops on it unless in a dry run.
 *
 * Extracted from `bot-cycle.js` to keep that file under the 500-line cap.
 */

"use strict";

const { log } = require("../lib/log");
const config = require("../lib/config");
const { readEnv } = require("../lib/env-settings");
const walletManager = require("../lib/wallet-manager");

/**
 * @param {object} [opts]
 * @param {(prompt: string) => Promise<string|null>} [opts.askPassword]
 *   Optional async function used for interactive password entry when
 *   `WALLET_PASSWORD` is not set.  Omit in non-interactive contexts.
 * @returns {Promise<string|null>}  Hex private key, or null.
 */
async function resolvePrivateKey(opts = {}) {
  const { askPassword } = opts;
  if (config.PRIVATE_KEY && /^(0x)?[0-9a-f]{64}$/i.test(config.PRIVATE_KEY))
    return config.PRIVATE_KEY;
  if (walletManager.hasWallet()) {
    // Through `readEnv`, which takes a blank value as none.
    const password =
      readEnv("WALLET_PASSWORD") ||
      (askPassword && (await askPassword("[bot] Enter wallet password: ")));
    if (!password) return null;
    log.info("[bot] Loading private key from imported wallet");
    return (await walletManager.revealWallet(password)).privateKey;
  }
  return null;
}

module.exports = { resolvePrivateKey };
