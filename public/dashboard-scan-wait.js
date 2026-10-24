/**
 * @file dashboard-scan-wait.js
 * @description A dialog waiting for a position's scan to end.
 *
 * The server refuses a Rebalance Now or a Compound Now while a scan is
 * running on the position (`scanInProgress`, src/scan-state.js). The
 * dialog the request came from then waits: the server's words beside a
 * spinner, Cancel, and no confirm button. Once a status answer says the
 * scan has ended, the notice goes and the confirm button comes back, so
 * the move is confirmed at that moment's price.
 *
 * Each dialog keeps its wait in an object of its own, `{ noticeId,
 * confirmId, key, timer }`: the ids of its notice and its confirm button,
 * the key of the position it waits on (null when it is not waiting), and
 * the timer that looks at the next status answer.
 */

"use strict";

import { g } from "./dashboard-helpers.js";
import { getLastStatus } from "./dashboard-data.js";
import { uiSetting } from "./dashboard-ui-settings.js";

// Where the status answers are read, which a test replaces.
let _latestStatus = getLastStatus;

/**
 * Test-only: read the status answers the dialogs wait on from `fn`.
 * @param {Function|null} fn  Returns a status answer; null restores the
 *   dashboard's own.
 */
export function _setStatusReaderForTests(fn) {
  _latestStatus = fn ?? getLastStatus;
}

/**
 * Wait for the position's scan: the server's words beside a spinner,
 * and no confirm button.
 * @param {object} wait  The dialog's wait.
 * @param {string} key  The position's composite key.
 * @param {string} message  The server's refusal.
 */
export function startScanWait(wait, key, message) {
  const notice = g(wait.noticeId);
  if (notice) {
    notice.textContent = message;
    notice.classList.add("9mm-pos-mgr-is-shown");
  }
  const confirm = g(wait.confirmId);
  if (confirm) confirm.hidden = true;
  wait.key = key;
  _watchScan(wait);
}

/** Look at the next status answer, and end the wait once the scan has. */
function _watchScan(wait) {
  clearTimeout(wait.timer);
  wait.timer = setTimeout(() => {
    if (wait.key === null) return;
    const st = _latestStatus()?._allPositionStates?.[wait.key];
    if (st?.scanInProgress === true) _watchScan(wait);
    else endScanWait(wait);
  }, uiSetting("dashboardPollIntervalMs"));
}

/**
 * End the wait: the notice goes, and the confirm button comes back.
 * @param {object} wait  The dialog's wait.
 */
export function endScanWait(wait) {
  clearTimeout(wait.timer);
  wait.timer = null;
  wait.key = null;
  const notice = g(wait.noticeId);
  if (notice) {
    notice.textContent = "";
    notice.classList.remove("9mm-pos-mgr-is-shown");
  }
  const confirm = g(wait.confirmId);
  if (confirm) confirm.hidden = false;
}
