/**
 * @file dashboard-start-refusal.js
 * @description What a tab does when the server refuses to start and is
 *   about to exit: a status answer carries why (`startRefusal`,
 *   src/server/server-routes.js `_refuseLaunch`), as with a `PRIVATE_KEY`
 *   for another wallet than the one imported. The tab logs it, adds it to
 *   the Activity Log, and shows it in the LP Ranger cannot start dialog:
 *   what is wrong, what to do, and that the server must be restarted. The
 *   server exits without waiting for the dialog, which stays on screen
 *   after it has gone. The Unlock dialog is closed, since the server
 *   unlocks nothing meanwhile. Run on every status answer
 *   (dashboard-data.js).
 */

import { act, cloneTpl } from "./dashboard-helpers.js";
import { log } from "./dashboard-log.js";
import { closeUnlockDialog } from "./dashboard-wallet.js";
import { START_REFUSAL_NOTICE_ID } from "./dashboard-app-notices.js";

/*- The refusal this tab has shown, so the next answers, which carry it
 *  until the server exits, do not show it again. */
let _shown = null;

/**
 * Whether this tab has shown the server's refusal to start. The page's
 * lock check then opens no Unlock dialog (dashboard-wallet.js), since the
 * server unlocks nothing while it waits to exit: the check can answer
 * after the refusal was shown, as on a page loaded during that wait.
 * @returns {boolean}
 */
export function startRefusalShown() {
  return _shown !== null;
}

/**
 * Show the server's refusal to start, once.
 * @param {string|null|undefined} refusal  The answer's `startRefusal`.
 */
export function showStartRefusal(refusal) {
  if (typeof refusal !== "string" || refusal === _shown) return;
  _shown = refusal;
  log.error("[lp-ranger] [server] LP Ranger cannot start: %s", refusal);
  act("⚠️", "warning", "LP Ranger Cannot Start", refusal);
  closeUnlockDialog();
  const frag = cloneTpl("tplStartRefusalModal");
  if (!frag) return;
  frag.querySelector('[data-tpl="reason"]').textContent = refusal;
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  o.id = START_REFUSAL_NOTICE_ID;
  o.appendChild(frag);
  o.querySelector("[data-dismiss-modal]").addEventListener("click", () =>
    o.remove(),
  );
  document.body.appendChild(o);
}
