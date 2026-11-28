/**
 * @file dashboard-unlock-button.js
 * @description The one owner of the Unlock Wallet button's state. It is
 *   enabled while the page holds the server's wallet locked, and
 *   disabled otherwise, its tooltip saying which: the wallet is already
 *   unlocked, or there is no wallet to unlock. Every path that changes
 *   whether there is a wallet to unlock paints it through here
 *   (dashboard-wallet.js, dashboard-wallet-import.js).
 */

import { g } from "./dashboard-helpers.js";

/*- Each state the button can be in: whether it is disabled, and its tooltip. */
const _STATES = {
  locked: { disabled: false, title: "Unlock wallet to manage positions" },
  unlocked: { disabled: true, title: "Wallet is already unlocked" },
  none: { disabled: true, title: "No wallet to unlock" },
};

/**
 * Paint Unlock Wallet for `state`.
 * @param {"locked"|"unlocked"|"none"} state  The page's wallet is locked,
 *   unlocked, or there is none.
 */
export function paintUnlockButton(state) {
  const b = g("unlockWalletBtn");
  if (!b) return;
  b.disabled = _STATES[state].disabled;
  b.title = _STATES[state].title;
}
