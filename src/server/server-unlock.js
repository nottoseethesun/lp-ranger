"use strict";

/**
 * @file src/server/server-unlock.js
 * @module server-unlock
 * @description
 * `POST /api/wallet/unlock`: the wallet password, entered in the
 * dashboard's Unlock Wallet dialog.
 *
 * Unlocking decrypts the wallet's key, which signs every transaction, and
 * with the same password the stored api keys (Telegram, Moralis). It is
 * idempotent: entering the password again changes nothing but those, and
 * they decrypt to what they already were. The start-up, which starts the
 * positions saved as managed (src/bot/auto-start.js), runs only when
 * this unlock is the one that takes the server from locked to unlocked.
 *
 * Why it matters: each open dashboard tab shows the dialog until it is
 * answered there, so the password can arrive a second time from another
 * tab, or from "Unlock Wallet" in a tab left in View-Only mode. A second
 * start-up over running positions gave each a fresh, empty record of its
 * state in place of the one its bot loop writes to, which left it on
 * "Syncing…", refused its Rebalance Now and Compound Now, and hid it from
 * the one-position-per-pool check until a restart.
 *
 * A wrong password is answered 401 and changes nothing. With no wallet
 * saved there is nothing to unlock: the request is answered 404, saying
 * so, and nothing is decrypted.
 *
 * While a wallet import is under way, an unlock is refused (409) and
 * changes nothing. It is asked again once the decrypt is done, since an
 * import can begin during it. The import is replacing the wallet this
 * password opens: an unlock then would hand the bot the old wallet's
 * key, and its start-up would start the old wallet's positions once the
 * new wallet is in.
 */

const { log } = require("../lib/log");
const unlockLog = require("./server-unlock-log");

// The answer to an unlock with no wallet saved.
const _NO_WALLET = "There is no wallet to unlock. Import one first.";

/**
 * Build the unlock route.
 *
 * @param {object} deps
 * @param {object} deps.walletManager  Says whether a wallet is saved
 *   (`hasWallet`) and decrypts it (`revealWallet(password)`), throwing on
 *   a wrong password.
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js):
 *   it says whether it may take a key now (`refusalToTakeKey`), is handed
 *   the decrypted key (`setPrivateKey`, `hasPrivateKey`) and starts the
 *   positions saved as managed (`startManagedPositions`).
 * @param {(password: string) => Promise<void>} deps.decryptApiKeys
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createUnlockHandler(deps) {
  const { walletManager, bot, decryptApiKeys, jsonResponse, readJsonBody } =
    deps;
  const warn = (what) => (e) => log.warn("[server] %s: %s", what, e.message);

  /**
   * Answer 409 when the bot may not take a key now, as during a wallet
   * import (`refusalToTakeKey`), naming why.
   * @param {object} res
   * @returns {boolean} Whether the unlock was refused.
   */
  function _refused(res) {
    const refusal = bot.refusalToTakeKey();
    if (refusal === null) return false;
    unlockLog.logUnlockRefused(refusal);
    jsonResponse(res, 409, { ok: false, error: refusal });
    return true;
  }

  return async function handleUnlock(req, res) {
    unlockLog.logUnlockRequest(req);
    const body = await readJsonBody(req);
    if (!body.password) {
      unlockLog.logUnlockMissing();
      return jsonResponse(res, 400, { ok: false, error: "Missing password" });
    }
    if (_refused(res)) return;
    if (!walletManager.hasWallet()) {
      unlockLog.logUnlockNoWallet();
      return jsonResponse(res, 404, { ok: false, error: _NO_WALLET });
    }
    unlockLog.logUnlockAttempt(String(body.password).length);
    const wasLocked = !bot.hasPrivateKey();
    let privateKey;
    try {
      ({ privateKey } = await walletManager.revealWallet(body.password));
    } catch (err) {
      unlockLog.logUnlockFail(err);
      return jsonResponse(res, 401, { ok: false, error: "Wrong password" });
    }
    // Asked again: an import may have begun during the decrypt.
    if (_refused(res)) return;
    bot.setPrivateKey(privateKey);
    unlockLog.logUnlockSuccess(req);
    decryptApiKeys(body.password).catch(warn("API key decrypt failed"));
    if (wasLocked) bot.startManagedPositions().catch(warn("Auto-start failed"));
    else
      log.info(
        "[server] Wallet already unlocked: password confirmed, managed positions left as they are",
      );
    jsonResponse(res, 200, { ok: true });
  };
}

module.exports = { createUnlockHandler };
