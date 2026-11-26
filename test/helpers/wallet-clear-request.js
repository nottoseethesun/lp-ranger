"use strict";

/**
 * @file test/helpers/wallet-clear-request.js
 * @description A Clear Wallet request (`DELETE /api/wallet`), sent
 *   through the server's own route (src/server/wallet-clear.js) over the
 *   tracker a test hands the unlock or the launch's key step, and the
 *   bot's own import phase (src/bot/app-phase.js), as a Clear in a
 *   dashboard tab is. Its `clearWallet` is the test's.
 */

const { createWalletClearRoute } = require("../../src/server/wallet-clear");
const { refusalToTakeKey } = require("../../src/bot/app-phase");

/**
 * A function that sends one Clear and gives back what it was answered.
 * @param {{inUse: Function}} walletInUse  The server's tracker
 *   (src/server/wallet-in-use.js) the test built its routes over.
 * @param {Function} [clearWallet]  What removing the wallet does.
 * @returns {() => {status: number, body: object}}
 */
function clearRequestOver(walletInUse, clearWallet = () => {}) {
  const route = createWalletClearRoute({
    walletManager: { clearWallet },
    walletInUse,
    bot: { refusalToTakeKey },
    jsonResponse: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
  });
  return () => {
    const res = {};
    route({}, res);
    return res;
  };
}

module.exports = { clearRequestOver };
