"use strict";

/**
 * @file src/server/server-unlock.js
 * @module server-unlock
 * @description
 * `POST /api/wallet/unlock`: the wallet password, entered in the
 * dashboard's Unlock Wallet dialog.
 *
 * Unlocking decrypts the wallet's key, which signs every transaction, and
 * with the same password the stored api keys (Telegram, Moralis). Both
 * decrypts finish before the bot takes the key, so no position starts
 * until Telegram and Moralis are set up or their decrypt has failed,
 * which is logged (the user's ruling, 2026-11-25: reliability before
 * responsiveness); the answer waits for both. It is
 * idempotent: entering the password again changes nothing but those, and
 * they decrypt to what they already were. The start-up, which starts the
 * positions saved as managed (src/bot/auto-start.js), runs only when
 * this unlock is the one that takes the server from locked to unlocked,
 * which is read just before the key is taken.
 *
 * Why it matters: a tab shows the dialog until it is answered there or
 * its next status answer says the server holds the key (`walletUnlocked`,
 * `dashboardPollIntervalMs` apart, three seconds as shipped), so
 * meanwhile the password can arrive a second time from another tab, or
 * from "Unlock Wallet" in a tab left in View-Only mode. A second
 * start-up over running positions would give each a fresh, empty record
 * of its state in place of the one its bot loop writes to. That would
 * leave it on "Syncing…", refuse its Rebalance Now and Compound Now, and
 * hide it from the one-position-per-pool check until a restart.
 *
 * A wrong password is answered 401 and changes nothing. With no wallet
 * loaded in the server (none saved when it started, or a Clear since)
 * there is nothing to unlock: the request is answered 404, saying so, and
 * nothing is decrypted; the dashboard then shows its Wallet file not
 * found notice, and Wallet Setup after it. The wallet is marked in use
 * from before it is asked for until the key is taken
 * (src/server/wallet-in-use.js), and a Clear is refused meanwhile
 * (src/server/wallet-clear.js), so it is still there at every step.
 *
 * While a wallet import is under way, an unlock is refused (409) and
 * takes no key. It is asked again after each decrypt, since an import
 * can begin during either. Refused after the api keys' decrypt, it
 * leaves them set up; the import decrypts them again with its own
 * password. The import is replacing the wallet this password opens: an
 * unlock then would hand the bot the old wallet's key, and its start-up
 * would start the old wallet's positions once the new wallet is in. An
 * import that lands during the wallet's decrypt makes that decrypt stale
 * (src/lib/wallet-manager.js), and one that begins during either decrypt
 * is found by the check after it: either way the unlock is refused with
 * `walletReplaced` set, which the dashboard takes quietly, never as a
 * wrong password or an error (the user's ruling, 2026-11-27). While the
 * server, having refused to start, waits to exit, an unlock is refused
 * too, saying so.
 */

const { log } = require("../lib/log");
const unlockLog = require("./server-unlock-log");

// The answer to an unlock with no wallet loaded.
const _NO_WALLET = "There is no wallet to unlock. Import one first.";

// The answer to an unlock whose decrypt another wallet made stale.
const _STALE =
  "Another wallet replaced this one while it was being unlocked. " +
  "Nothing was unlocked.";

// The answer to an unlock while the server, having refused to start, waits to exit.
const _STOPPING =
  "LP Ranger cannot start and is stopping, so there is nothing to unlock.";

/**
 * Build the unlock route.
 *
 * @param {object} deps
 * @param {object} deps.walletManager  Says whether a wallet is loaded
 *   (`hasWallet`) and decrypts it (`revealWallet(password)`), throwing on
 *   a wrong password, and with `staleWallet` set when another wallet
 *   replaced it during the decrypt.
 * @param {{begin: Function, end: Function}} deps.walletInUse  Marks the
 *   wallet in use while the unlock runs (src/server/wallet-in-use.js).
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js):
 *   it says whether it may take a key now (`refusalToTakeKey`), is handed
 *   the decrypted key (`setPrivateKey`, `hasPrivateKey`) and starts the
 *   positions saved as managed (`startManagedPositions`).
 * @param {(password: string) => Promise<void>} deps.decryptApiKeys
 * @param {() => (string|null)} deps.startRefusal  Why the launch was
 *   refused, while the server waits to exit (src/server/server-routes.js).
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createUnlockHandler(deps) {
  const {
    walletManager,
    walletInUse,
    bot,
    decryptApiKeys,
    startRefusal,
    jsonResponse,
    readJsonBody,
  } = deps;
  const warn = (what) => (e) => log.warn("[server] %s: %s", what, e.message);

  /**
   * Answer 409 when the bot may not take a key now, as during a wallet
   * import (`refusalToTakeKey`), naming why. Asked after a decrypt
   * (`overtaken`), the import began during it: `walletReplaced` is set,
   * and the dashboard takes the answer quietly, as for a stale decrypt
   * (`_stale`), since nothing is wrong.
   * @param {object} res
   * @param {boolean} [overtaken=false]  Whether a decrypt has run.
   * @returns {boolean} Whether the unlock was refused.
   */
  function _refused(res, overtaken = false) {
    const refusal = bot.refusalToTakeKey();
    if (refusal === null) return false;
    unlockLog.logUnlockRefused(refusal);
    const answer = { ok: false, error: refusal };
    if (overtaken) answer.walletReplaced = true;
    jsonResponse(res, 409, answer);
    return true;
  }

  /**
   * Answer 409 for a decrypt another wallet made stale: an import replaced
   * the wallet during it (src/lib/wallet-manager.js). `walletReplaced` is
   * set, and the dashboard takes the answer quietly, showing no error
   * (the user's ruling, 2026-11-27): nothing is wrong, the import goes on
   * as normal, and the tab follows the new wallet once it has finished.
   * @param {object} res
   */
  function _stale(res) {
    unlockLog.logUnlockRefused(_STALE);
    jsonResponse(res, 409, { ok: false, walletReplaced: true, error: _STALE });
  }

  /**
   * The unlock itself, run while the wallet is marked in use: the wallet
   * is asked for once, decrypted, then the api keys, then the key is
   * taken and the start-up begun. No Clear can remove the wallet partway
   * (src/server/wallet-clear.js).
   * @param {object} req
   * @param {object} res
   * @param {string} password
   * @returns {Promise<void>}
   */
  async function _unlock(req, res, password) {
    if (!walletManager.hasWallet()) {
      unlockLog.logUnlockNoWallet();
      return jsonResponse(res, 404, { ok: false, error: _NO_WALLET });
    }
    unlockLog.logUnlockAttempt(String(password).length);
    let privateKey;
    try {
      ({ privateKey } = await walletManager.revealWallet(password));
    } catch (err) {
      if (err.staleWallet === true) return _stale(res);
      unlockLog.logUnlockFail(err);
      return jsonResponse(res, 401, { ok: false, error: "Wrong password" });
    }
    // Asked again: an import may have begun during the decrypt.
    if (_refused(res, true)) return;
    /*-
     *  The api keys are decrypted before the bot takes the key, so no
     *  position starts until that decrypt has ended. A failure is logged
     *  and the unlock goes on.
     */
    await decryptApiKeys(password).catch(warn("api key decrypt failed"));
    // And again, since one can begin during that decrypt too.
    if (_refused(res, true)) return;
    /*-
     *  Read only now, just before the key is taken: the launch can have
     *  taken it during the decrypts, and then started the positions.
     */
    const wasLocked = !bot.hasPrivateKey();
    bot.setPrivateKey(privateKey);
    unlockLog.logUnlockSuccess(req);
    if (wasLocked) bot.startManagedPositions().catch(warn("Auto-start failed"));
    else
      log.info(
        "[server] Wallet already unlocked: password confirmed, managed positions left as they are",
      );
    jsonResponse(res, 200, { ok: true });
  }

  return async function handleUnlock(req, res) {
    unlockLog.logUnlockRequest(req);
    const body = await readJsonBody(req);
    if (!body.password) {
      unlockLog.logUnlockMissing();
      return jsonResponse(res, 400, { ok: false, error: "Missing password" });
    }
    // Having refused to start, the server waits to exit: it unlocks nothing.
    if (startRefusal() !== null) {
      unlockLog.logUnlockRefused(_STOPPING);
      return jsonResponse(res, 409, { ok: false, error: _STOPPING });
    }
    if (_refused(res)) return;
    /*-
     *  In use from before the wallet is asked for until the key is taken
     *  and the start-up begun, which reads the wallet's address at once.
     */
    walletInUse.begin();
    try {
      await _unlock(req, res, body.password);
    } finally {
      walletInUse.end();
    }
  };
}

module.exports = { createUnlockHandler };
