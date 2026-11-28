/**
 * @file dashboard-rebalance-log-notice.js
 * @description The Rebalance log error dialog. Every status answer
 *   carries the last failed read or write of the rebalance log since the
 *   server started (`rebalanceLogProblem`, src/bot/rebalance-log.js): the
 *   server's words for the operator, which say whether reading or writing
 *   failed, advise checking the file's permissions and whether the disk
 *   is full, then restarting LP Ranger and reloading the position. The
 *   tab logs it, adds it to the Activity Log and shows it, once for each
 *   failure: a later one replaces the dialog, should it still be open.
 *   Run on every status answer (dashboard-data.js).
 */

import { act, cloneTpl } from "./dashboard-helpers.js";
import { log } from "./dashboard-log.js";
import { REBALANCE_LOG_NOTICE_ID } from "./dashboard-app-notices.js";

/*- When the failure this tab last showed happened, so the next answers,
 *  which carry it until the server restarts, do not show it again. */
let _shownAt = null;

/**
 * Show a failed read or write of the rebalance log, once for each.
 * Server text is written with `textContent`, one paragraph per block
 * apart by a blank line, never as markup.
 * @param {{message: string, at: number}|null|undefined} problem  The
 *   answer's `rebalanceLogProblem`.
 */
export function showRebalanceLogProblem(problem) {
  if (problem === null || problem === undefined) return;
  if (problem.at === _shownAt) return;
  _shownAt = problem.at;
  log.error("[lp-ranger] [bot] Rebalance log error: %s", problem.message);
  act("⚠️", "warning", "Rebalance Log Error", problem.message);
  const open = document.getElementById(REBALANCE_LOG_NOTICE_ID);
  if (open !== null) open.remove();
  const frag = cloneTpl("tplRebalanceLogModal");
  if (!frag) return;
  const body = frag.querySelector('[data-tpl="message"]');
  for (const block of problem.message.split("\n\n")) {
    const p = document.createElement("p");
    p.textContent = block;
    body.appendChild(p);
  }
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  o.id = REBALANCE_LOG_NOTICE_ID;
  o.appendChild(frag);
  o.querySelector("[data-dismiss-modal]").addEventListener("click", () =>
    o.remove(),
  );
  document.body.appendChild(o);
}
