"use strict";

/**
 * @file src/lib/server-unlock.js
 * @module server-unlock
 * @description
 * `POST /api/wallet/unlock`: the wallet password, entered in the
 * dashboard's Unlock Wallet dialog.
 *
 * Unlocking decrypts the wallet's key, which signs every transaction, and
 * with the same password the stored api keys (Telegram, Moralis). It is
 * idempotent: entering the password again changes nothing but those, and
 * they decrypt to what they already were. The start-up, which starts the
 * positions saved as managed (src/lib/server-auto-start.js), runs only when
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
 * A wrong password is answered 401 and changes nothing.
 */

const { log } = require("./log");
const unlockLog = require("./server-unlock-log");

/**
 * Build the unlock route.
 *
 * @param {object} deps
 * @param {object} deps.walletManager  Decrypts the wallet
 *   (`revealWallet(password)`), throwing on a wrong password.
 * @param {{current: (string|null)}} deps.privateKeyRef  The decrypted
 *   key, null while the wallet is locked.
 * @param {(password: string) => Promise<void>} deps.decryptApiKeys
 * @param {() => Promise<void>} deps.startManagedPositions  The start-up.
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createUnlockHandler(deps) {
  const {
    walletManager,
    privateKeyRef,
    decryptApiKeys,
    startManagedPositions,
    jsonResponse,
    readJsonBody,
  } = deps;
  const warn = (what) => (e) => log.warn("[server] %s: %s", what, e.message);

  return async function handleUnlock(req, res) {
    unlockLog.logUnlockRequest(req);
    const body = await readJsonBody(req);
    if (!body.password) {
      unlockLog.logUnlockMissing();
      return jsonResponse(res, 400, { ok: false, error: "Missing password" });
    }
    unlockLog.logUnlockAttempt(String(body.password).length);
    const wasLocked =
      privateKeyRef.current === null || privateKeyRef.current === undefined;
    try {
      privateKeyRef.current = (
        await walletManager.revealWallet(body.password)
      ).privateKey;
    } catch (err) {
      unlockLog.logUnlockFail(err);
      return jsonResponse(res, 401, { ok: false, error: "Wrong password" });
    }
    unlockLog.logUnlockSuccess(req);
    decryptApiKeys(body.password).catch(warn("API key decrypt failed"));
    if (wasLocked) startManagedPositions().catch(warn("Auto-start failed"));
    else
      log.info(
        "[server] Wallet already unlocked: password confirmed, managed positions left as they are",
      );
    jsonResponse(res, 200, { ok: true });
  };
}

module.exports = { createUnlockHandler };
