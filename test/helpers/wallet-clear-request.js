"use strict";

/**
 * @file test/helpers/wallet-clear-request.js
 * @description A Clear Wallet request (`DELETE /api/wallet`), sent
 *   through the server's own route (src/server/wallet-clear.js) over the
 *   tracker a test hands the unlock or the launch's key step, the bot's
 *   own phases (src/bot/app-phase.js: an import, a start-up) and its own
 *   rule on a move under way or a position starting
 *   (src/bot/under-way.js), as a Clear in a dashboard tab is. What
 *   removing the wallet, halting the positions and forgetting the session
 *   password do is the test's; the `.env` it would edit is none, unless
 *   the test names one.
 */

const { createWalletClearRoute } = require("../../src/server/wallet-clear");
const {
  refusalToTakeKey,
  startUpProgress,
  startUpRefusal,
} = require("../../src/bot/app-phase");
const { walletChangeRefusal } = require("../../src/bot/under-way");

/**
 * A function that sends one Clear and gives back what it was answered.
 * @param {{inUse: Function}} walletInUse  The server's tracker
 *   (src/server/wallet-in-use.js) the test built its routes over.
 * @param {Function} [clearWallet]  What removing the wallet does.
 * @param {object} [also]
 * @param {Function} [also.forgetWallet]  What halting every position and
 *   forgetting the key does (the bot's `forgetWallet`).
 * @param {Function} [also.forgetSessionPassword]
 * @param {() => (string|null)} [also.envFile]  The `.env` to remove
 *   PRIVATE_KEY and WALLET_PASSWORD from, or null for none.
 * @param {() => (string|null)} [also.startRefusal]  Why the launch was
 *   refused (the route handlers' `startRefusal`), or none.
 * @param {() => Map<string, object>} [also.states]  The positions' bot
 *   states, for the bot's own rule on a move under way
 *   (src/bot/under-way.js); none, unless the test passes them.
 * @param {() => string[]} [also.startingKeys]  The positions whose start
 *   is under way; none, unless the test passes them.
 * @returns {() => Promise<{status: number, body: object}>}
 */
function clearRequestOver(walletInUse, clearWallet = () => {}, also = {}) {
  const states = also.states ?? (() => new Map());
  const startingKeys = also.startingKeys ?? (() => []);
  const route = createWalletClearRoute({
    walletManager: { clearWallet },
    walletInUse,
    bot: {
      refusalToTakeKey,
      startUpProgress,
      startUpRefusal,
      refusalToChangeWallet: (action) =>
        walletChangeRefusal(states(), startingKeys(), action),
      forgetWallet: also.forgetWallet ?? (() => {}),
    },
    forgetSessionPassword: also.forgetSessionPassword ?? (() => {}),
    startRefusal: also.startRefusal ?? (() => null),
    envFile: also.envFile ?? (() => null),
    jsonResponse: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
  });
  return async () => {
    const res = {};
    await route({}, res);
    return res;
  };
}

module.exports = { clearRequestOver };
