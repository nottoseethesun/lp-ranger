"use strict";

/**
 * @file src/server/wallet-change.js
 * @module wallet-change
 * @description Tells every open dashboard when the server's wallet has
 *   been replaced by another (the user's design, 2026-11-25): a tab still
 *   on the old wallet can do nothing right for it, and reloads
 *   (src/client/web/js/dashboard-wallet-change.js). The change is worked
 *   out from the wallet each `GET /api/status` answer reports, by the
 *   tracker its handler makes (src/server/handle-api-status.js). Once a
 *   wallet has followed another, every answer carries `walletJustChanged:
 *   { reloadIfOnPriorWallet: true, currentWallet }`, the new wallet's
 *   address, until the next change.
 *
 *   It is set once for each change, and kept rather than sent in a single
 *   answer: a browser slows the polls of a tab in the background, and such
 *   a tab would miss one answer. Kept, it reloads no tab twice, since a
 *   tab reloads only while it holds a wallet other than `currentWallet`,
 *   and a reloaded tab takes the server's. A clear reports nothing, and
 *   the wallet it removed stays the one a later import is compared with,
 *   so a clear followed by an import is a change too.
 */

const { log } = require("../lib/log");

/**
 * Whether two addresses name the same wallet, whatever their letter case.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _sameWallet(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Make the tracker of the server's wallet changes, one per status handler,
 * so one per server.
 * @returns {{walletJustChanged: (wallet: (string|null)) => (object|null)}}
 */
function createWalletChangeTracker() {
  // The last wallet an answer reported; a clear leaves it.
  let lastWallet = null;
  // The change every answer reports: none until a wallet replaces another.
  let change = null;
  return {
    /**
     * The change to report beside `wallet`, the wallet this answer
     * reports, null while none is loaded. Notes a change the first time
     * an answer reports the new wallet.
     * @param {string|null} wallet
     * @returns {{reloadIfOnPriorWallet: boolean, currentWallet: string}|null}
     */
    walletJustChanged(wallet) {
      if (wallet === null || wallet === undefined || wallet === "")
        return change;
      if (lastWallet !== null && !_sameWallet(lastWallet, wallet)) {
        change = { reloadIfOnPriorWallet: true, currentWallet: wallet };
        log.info(
          "[server] Wallet changed from %s to %s: a dashboard tab still on the old one reloads",
          lastWallet,
          wallet,
        );
      }
      lastWallet = wallet;
      return change;
    },
  };
}

module.exports = { createWalletChangeTracker };
