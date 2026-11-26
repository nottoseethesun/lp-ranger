/**
 * @file dashboard-wallet-change.js
 * @description Reloads a tab left on a wallet the server no longer holds
 *   (the user's design, 2026-11-25). Once another tab's import replaces
 *   the server's wallet, every status answer names the new one
 *   (`walletJustChanged`, src/server/wallet-change.js), and a tab still
 *   holding another wallet reloads:
 *   - once the import has finished (`importingWallet` false), so it never
 *     meets the new wallet before the server holds its key, which would
 *     show the unlock dialog;
 *   - at the dashboard's start address, since its own address names the
 *     old wallet and would open the wallet dialog;
 *   - not while it holds no wallet, so nothing typed into its dialog is
 *     lost;
 *   - not while it is making an import itself: the server takes the new
 *     wallet before it answers, so a status answer naming it can come
 *     first (`noteWalletImportStarted`, `noteWalletImportEnded`).
 *   A reloaded tab takes the server's wallet, so it never reloads again.
 */

import { log } from "./dashboard-log.js";

// Whether this tab has sent an import whose answer it has not taken in yet.
let _importUnderWayHere = false;

/** Note that this tab has sent the server a wallet to import. */
export function noteWalletImportStarted() {
  _importUnderWayHere = true;
}

/** Note that this tab's import is answered, and its wallet taken in when accepted. */
export function noteWalletImportEnded() {
  _importUnderWayHere = false;
}

/**
 * Whether a tab holding `pageWallet` reloads on a status answer: the
 * server's wallet has replaced another, the import that did it has
 * finished, this tab is making none, and it holds a wallet other than the
 * new one. Pure.
 * @param {object} data  The status answer, its global fields at the top.
 * @param {string|null} pageWallet  The wallet this tab holds.
 * @param {boolean} importingHere  Whether this tab is making an import.
 * @returns {boolean}
 */
export function shouldReloadForWalletChange(data, pageWallet, importingHere) {
  const change = data.walletJustChanged;
  if (change === null || change === undefined) return false;
  if (change.reloadIfOnPriorWallet !== true) return false;
  if (data.importingWallet === true || importingHere) return false;
  if (pageWallet === null || pageWallet === undefined || pageWallet === "")
    return false;
  return pageWallet.toLowerCase() !== change.currentWallet.toLowerCase();
}

/*-
 *  How the tab goes to an address. `replace` takes the place of the
 *  tab's current address in its history, so Back does not return to
 *  that one. Earlier entries that name the old wallet stay; a page Back
 *  brings back is an address like any other, and asks for the wallet it
 *  names (dashboard-wallet.js).
 */
let _navigate = (url) => window.location.replace(url);

/**
 * TEST-ONLY seam: take the navigation in place of the browser's, as
 * jsdom navigates nowhere.
 * @param {(url: string) => void} fn
 * @returns {() => void}  Puts the browser's back.
 */
export function _setNavigateForTests(fn) {
  const prior = _navigate;
  _navigate = fn;
  return () => {
    _navigate = prior;
  };
}

/**
 * Reload this tab at the dashboard's start address when the server's
 * wallet has replaced the one it holds (`shouldReloadForWalletChange`).
 * @param {object} data  The status answer.
 * @param {string|null} pageWallet  The wallet this tab holds.
 * @returns {boolean}  True when it reloads: the answer is for nothing more.
 */
export function reloadIfOnPriorWallet(data, pageWallet) {
  if (!shouldReloadForWalletChange(data, pageWallet, _importUnderWayHere))
    return false;
  log.info(
    "[lp-ranger] [wallet-change] the server's wallet is now %s, and this tab holds %s: reloading",
    data.walletJustChanged.currentWallet,
    pageWallet,
  );
  _navigate("/");
  return true;
}
