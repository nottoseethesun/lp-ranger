"use strict";

/**
 * @file src/server/wallet-clear.js
 * @module wallet-clear
 * @description
 * `DELETE /api/wallet`: Clear Wallet, which removes the stored wallet,
 * its file included (src/lib/wallet-manager.js `clearWallet`). Refused
 * (409, saying why) while the server is using the wallet: an unlock or
 * the launch's key step under way (src/server/wallet-in-use.js), or a
 * wallet import (src/bot/app-phase.js). So no decrypt finds its wallet
 * gone partway, which made the wallet's own decrypt fail as a wrong
 * password and stopped a launch (the user's design, 2026-11-26). Every
 * status answer carries the same refusal as `clearWalletRefusal`
 * (src/server/handle-api-status.js), so each tab disables Clear Wallet
 * meanwhile, the refusal its tooltip.
 */

const { log } = require("../lib/log");

// Why a Clear is refused while an unlock or the launch's key step runs.
const _UNLOCKING =
  "LP Ranger is unlocking the wallet, or waiting for its password at " +
  "its terminal. Try Clear Wallet again once that has finished.";

// Why a Clear is refused while a wallet import is under way.
const _IMPORTING =
  "LP Ranger is importing a wallet. Try Clear Wallet again once the " +
  "import has finished.";

/**
 * Why a Clear is refused now, or null when it may go ahead.
 * @param {{inUse: Function}} walletInUse  The server's tracker.
 * @param {{refusalToTakeKey: Function}} bot  The bot's interface: its
 *   refusal to take a key is set exactly while a wallet import is under
 *   way.
 * @returns {string|null}
 */
function refusalToClear(walletInUse, bot) {
  if (bot.refusalToTakeKey() !== null) return _IMPORTING;
  if (walletInUse.inUse()) return _UNLOCKING;
  return null;
}

/**
 * Build the Clear Wallet route.
 * @param {object} deps
 * @param {object} deps.walletManager  Removes the wallet (`clearWallet`).
 * @param {{inUse: Function}} deps.walletInUse
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js).
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`
 * @returns {(req: object, res: object) => void}
 */
function createWalletClearRoute(deps) {
  const { walletManager, walletInUse, bot, jsonResponse } = deps;
  return function handleWalletClear(_req, res) {
    const refusal = refusalToClear(walletInUse, bot);
    if (refusal !== null) {
      log.warn("[server] DELETE /api/wallet refused: %s", refusal);
      return jsonResponse(res, 409, { ok: false, error: refusal });
    }
    log.warn("[server] DELETE /api/wallet received — clearing wallet file");
    walletManager.clearWallet();
    return jsonResponse(res, 200, { ok: true });
  };
}

module.exports = { refusalToClear, createWalletClearRoute };
