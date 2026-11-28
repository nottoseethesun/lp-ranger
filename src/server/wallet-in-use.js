"use strict";

/**
 * @file src/server/wallet-in-use.js
 * @module wallet-in-use
 * @description
 * Whether the server is using the stored wallet. The dashboard's unlock
 * (src/server/server-unlock.js) and the launch's key step (`_keyStep`,
 * src/server/server-routes.js) mark it from their first step, the
 * terminal prompt of `--unlock-at-terminal` included, until the bot holds the key
 * and the start-up has begun, or the step ends without a key. The prompt
 * holds it until it is answered, even after a dashboard unlock has taken
 * the key; whatever is typed there is then ignored, so pressing Enter
 * ends the wait. Reveal Key
 * (`_handleWalletReveal`, same file) marks it while it decrypts. A wallet
 * import marks its whole run through its own phase (src/bot/app-phase.js)
 * instead.
 *
 * A Clear (`DELETE /api/wallet`, src/server/wallet-clear.js) is refused
 * while the wallet is in use, so no decrypt finds its wallet gone partway
 * (the user's design, 2026-11-26). Built by the entry point
 * (src/server.js) and handed to each path; it does nothing as it loads.
 */

/**
 * A count of the paths using the wallet now.
 * @returns {{begin: Function, end: Function, inUse: Function}}
 */
function createWalletInUse() {
  let users = 0;
  return {
    /** Mark one path as using the wallet. */
    begin() {
      users++;
    },
    /** Mark it as done, in a `finally`, so it always balances its begin. */
    end() {
      users--;
    },
    /** @returns {boolean} Whether any path is using the wallet now. */
    inUse() {
      return users > 0;
    },
  };
}

module.exports = { createWalletInUse };
