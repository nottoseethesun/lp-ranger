/**
 * @file dashboard-rebalance-confirm.js
 * @description Mild-IL confirmation modal for the Rebalance action.
 *
 * Replaces the "Rebalance with Updated Range" modal shell that used to
 * live in `dashboard-throttle-rebalance.js`.  Range width is now a
 * persistent per-position config value (see the "Migrate Rebalance UI
 * dialog into Bot Settings" plan) — this modal's only job is to warn
 * about the impermanent-loss impact of a manual rebalance before
 * firing the request.
 *
 * Exports:
 *  - `openRebalanceConfirm()`    — Mission-Control-button handler
 *  - `closeRebalanceConfirm()`   — Cancel button + Escape wire
 *  - `confirmRebalance()`        — Rebalance Anyway button
 *  - `_postRebalance(url, body)` — shared POST helper reused by
 *    `dashboard-reopen-flow.js` for the closed-position re-open path
 *
 * The server refuses a Rebalance Now while a scan is running on the
 * position (`scanInProgress`, src/lib/scan-state.js). The dialog then stays
 * open, showing the server's words beside a spinner, with Cancel and no
 * confirm button; once a status answer says the scan has ended, the
 * confirm button comes back, so the rebalance is confirmed at that
 * moment's price (dashboard-scan-wait.js).
 */

"use strict";

import { log } from "./dashboard-log.js";
import {
  g,
  act,
  ACT_ICONS,
  compositeKey,
  fetchWithCsrf,
  emojiId,
  isFullRangeSpread,
} from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";
import {
  _createModal,
  _posContextHtml,
  posLabelOf,
} from "./dashboard-data-status.js";
import { isAnswerForPositionOnScreen } from "./dashboard-answer-position.js";
import { poolRuleRefusal } from "./dashboard-manage-refusal.js";
import { getLastStatus } from "./dashboard-data.js";
import {
  findActiveAction,
  setOptimisticSpecialAction,
} from "./dashboard-mission-badge.js";
import { showQueuedActionModal } from "./dashboard-compound.js";
import {
  paintManageUI,
  setManageInFlight,
  manageKey,
} from "./dashboard-manage-ui.js";
import { activeChainId } from "./dashboard-chain.js";
import { startScanWait, endScanWait } from "./dashboard-scan-wait.js";

// The dialog's wait for a scan running on its position.
const _scanWait = {
  noticeId: "rebalanceScanWait",
  confirmId: "ilWarnConfirmBtn",
  key: null,
  timer: null,
};

/**
 * "preserveRange width" as % — the width the rebalancer would
 * produce for a position with the given tick spread + Position
 * Offset.  Matches `src/lib/range-math.js:preserveRange()`:
 *     belowTicks = spread * (100 - offset) / 100
 *     aboveTicks = spread * offset / 100
 *     widthPct   = (1.0001^aboveTicks - 1.0001^(-belowTicks)) * 100
 * For offset=50 (centered) this simplifies to the symmetric form;
 * for other offsets the exponents differ (asymmetric range).
 * INDEPENDENT of `currentPrice` — pure function of (spread, offset).
 * Returns a two-decimal string or null when inputs are missing /
 * non-finite.
 */
export function _computePreservedWidthPct(tickLower, tickUpper, offset) {
  if (
    tickLower === undefined ||
    tickLower === null ||
    tickUpper === undefined ||
    tickUpper === null ||
    !Number.isFinite(tickLower) ||
    !Number.isFinite(tickUpper)
  )
    return null;
  const spread = tickUpper - tickLower;
  if (!Number.isFinite(spread) || !(spread > 0)) return null;
  if (!Number.isFinite(offset) || offset < 0 || offset > 100) return null;
  /*- Full-range positions overflow the widthPct formula (see
   *  dashboard-data-range-width.js for the numeric detail).  Same
   *  100.00 convention keeps the modal preview and the Bot Settings
   *  row in sync. */
  if (isFullRangeSpread(spread)) return "100.00";
  const aboveTicks = (spread * offset) / 100;
  const belowTicks = (spread * (100 - offset)) / 100;
  const widthPct =
    (Math.pow(1.0001, aboveTicks) - Math.pow(1.0001, -belowTicks)) * 100;
  if (!Number.isFinite(widthPct) || !(widthPct > 0)) return null;
  return widthPct.toFixed(2);
}

/**
 * Compact "X%" range-width value for the modal's position-context
 * data-list line.  Pulls from getLastStatus() — the same source the
 * Bot Configuration row's `syncRangeWidth` reads on every poll, so the
 * preview matches what a subsequent rebalance will actually apply.
 * A pre-populated but unsaved input value does NOT influence this —
 * only the saved config value or the preserveRange fallback.  The
 * offset is the one the same status payload says the rebalance will
 * use (`rebalanceOffsetToken0Pct`), so the value accounts for a
 * non-centred Position Offset, saved or the install's default.
 * Returns an em-dash when neither source yields a finite value.
 */
export function _rangeWidthPreviewText(status, active) {
  /*- The Range section's "No Override" toggle gates all three Range
   *  settings.  When it is on, the rebalance re-uses the existing
   *  on-chain spread centred on the current price, so the preview must
   *  ignore the saved width, the Full-Range flag AND the saved offset —
   *  otherwise it promises a range the rebalance will not mint. */
  const overrideActive = status?.rangeOverrideEnabled === true;
  /*- Full-Range checkbox wins over any saved Price Range Extension —
   *  the rebalance will mint at MIN_TICK / MAX_TICK via
   *  rangeMath.fullRange().  Show "Full-Range" rather than a numeric
   *  percentage so the user isn't surprised by an astronomically wide
   *  mint. */
  if (overrideActive && status?.fullRangeRebalanceEnabled === true) {
    return "Full-Range";
  }
  const saved = status?.rebalanceRangeWidthPct;
  if (
    overrideActive &&
    saved !== undefined &&
    saved !== null &&
    Number.isFinite(saved)
  ) {
    return String(saved) + "%";
  }
  /*-
   *  The offset the rebalance will use, as the server resolves it: the
   *  saved one, the install's default, or centred under "No Override"
   *  (src/lib/range-override.js). Without it the preview shows a dash
   *  rather than assume a centre.
   */
  const preserved = _computePreservedWidthPct(
    active?.tickLower,
    active?.tickUpper,
    status?.rebalanceOffsetToken0Pct,
  );
  return preserved ? preserved + "%" : "—";
}

/** Open the mild-IL confirmation modal for a manual rebalance.  The
 *  Range Width line is appended to the position-context paragraph as
 *  a fourth data-list row (below "chain · wallet") so all identifying
 *  data lives in one block; textContent (not innerHTML) is used for
 *  the width value so the assembled string can't inject markup. */
export function openRebalanceConfirm() {
  const modal = g("rebalanceIlWarningModal");
  if (!modal) return;
  endScanWait(_scanWait);
  const active = posStore.getActive();
  const ctx = g("rebalanceIlWarningCtx");
  if (ctx) {
    ctx.innerHTML = active ? _posContextHtml() : "";
    const p = ctx.querySelector("p");
    if (p) {
      const width = _rangeWidthPreviewText(getLastStatus(), active);
      p.appendChild(document.createElement("br"));
      p.appendChild(document.createTextNode("Price Range Extension: " + width));
    }
  }
  modal.classList.remove("hidden");
}

/** Hide the modal without firing a rebalance. */
export function closeRebalanceConfirm() {
  endScanWait(_scanWait);
  const m = g("rebalanceIlWarningModal");
  if (m) m.classList.add("hidden");
}

// The tooltip both action buttons show while a rebalance request is in flight.
const _SUBMITTING_HELP =
  "LP Ranger is currently submitting transactions" +
  " to the blockchain to rebalance this LP Position.";

/**
 * Optimistically disable the Rebalance button for the duration of the
 * in-flight POST so the user sees feedback immediately. The Manage button
 * is drawn disabled by `paintManageUI()`, from the in-flight label
 * `_postRebalance` sets.
 */
function _disableRebalanceButtonForInFlight() {
  const _rebBtn = g("rebalanceWithRangeBtn");
  if (_rebBtn) {
    _rebBtn.disabled = true;
    _rebBtn.title = _SUBMITTING_HELP;
  }
}

/**
 * Render the "Rebalance Blocked / Failed" caution modal + activity log
 * entry. Shared by the response-not-ok and network-exception branches.
 * The entry names the position the request was for. The dialog shows
 * only while that position is on screen, since it reads as being about
 * whatever is.
 * @param {string} title
 * @param {string} detail  Plain text, the server's words included.
 * @param {object|null} active  The position the request was for.
 * @param {boolean} onScreen    Whether it is still the one on screen.
 */
function _showRebalanceError(title, detail, active, onScreen) {
  if (onScreen) {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      title,
      _posContextHtml() + "<p data-rebalance-error></p>",
    );
    /*-
     *  The detail can carry the server's words, so it goes in as text,
     *  into the dialog just built: the page's last element.
     */
    const dialog = document.body.lastElementChild;
    const slot = dialog.querySelector("[data-rebalance-error]");
    if (slot !== null) slot.textContent = detail;
  }
  const _p = posLabelOf(active);
  act(ACT_ICONS.warn, "alert", title, detail + (_p ? "\n" + _p : ""));
}

/**
 * Handle a 200 OK response: optimistic action + queued-action modal +
 * activity log entry. The first two belong to the screen, so they wait
 * for the position the request was for to be the one on screen; the
 * entry names that position either way.
 * @param {object|null} active  The position the request was for.
 * @param {object|null} inFlight  Another action under way, if any.
 * @param {string} url
 * @param {string} triggerActLabel
 * @param {boolean} onScreen  Whether `active` is still on screen.
 */
function _handleRebalanceOk(active, inFlight, url, triggerActLabel, onScreen) {
  if (active && onScreen) {
    setOptimisticSpecialAction("rebalance", {
      tokenId: active.tokenId,
      fee: active.fee,
      token0Symbol: active.token0Symbol,
      token1Symbol: active.token1Symbol,
    });
  }
  if (inFlight && onScreen) showQueuedActionModal("rebalance", inFlight);
  const _pl = posLabelOf(active);
  const _tid = active?.tokenId;
  log.info(
    "[lp-ranger] [rebalance-confirm] posted %s for #%s %s",
    url,
    _tid,
    _tid ? emojiId(String(_tid)) : "",
  );
  act(ACT_ICONS.lasso, "start", triggerActLabel, _pl || "");
}

/*- Shared POST helper for the two rebalance-triggering call sites:
 *  (a) `confirmRebalance` (this file) — Mission Control button.
 *  (b) `dashboard-reopen-flow.js`'s intro modal Re-open button —
 *      closed-position re-open path (POSTs /api/position/manage
 *      with `forceRebalance: true`).
 *
 *  Consolidates the setManageInFlight + fetch + optimistic-action +
 *  queued-action + error-modal + activity-log dance so both paths
 *  behave identically on success/failure.  Returns nothing; side
 *  effects only.
 *
 *  Never sends `customRangeWidthPct` in the body — range width is a
 *  persistent per-position config value read by the bot loop.
 *
 * @param {string} url                   `/api/rebalance` or `/api/position/manage`
 * @param {object} body                  Request body (positionKey OR tokenId+contract+forceRebalance)
 * @param {object} active                posStore active entry (for optimistic-action + logging)
 * @param {string} triggerActLabel       Activity-log label ("Manual Rebalance" or "Re-open Position")
 * @returns {Promise<object|null>}  The server's answer, or null when none
 *   came.
 */
export async function _postRebalance(url, body, active, triggerActLabel) {
  _disableRebalanceButtonForInFlight();
  if (active) {
    setManageInFlight(manageKey(active), { title: _SUBMITTING_HELP });
    paintManageUI();
  }
  const inFlight = findActiveAction(getLastStatus()?._allPositionStates);
  /*-
   *  The position the request is for, as the answer will name it. A
   *  re-open answers only once its first rebalance is done, minutes
   *  later, and the screen may hold another position by then.
   */
  const requestKey =
    body.positionKey ??
    (active
      ? compositeKey(
          activeChainId(),
          active.walletAddress,
          active.contractAddress,
          active.tokenId,
        )
      : undefined);
  let data = null;
  try {
    const res = await fetchWithCsrf(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
    _settleRebalanceAnswer({
      data,
      requestKey,
      active,
      inFlight,
      url,
      triggerActLabel,
    });
  } catch {
    _showRebalanceError(
      "Rebalance Failed",
      "Server unreachable",
      active,
      isAnswerForPositionOnScreen(null, requestKey),
    );
  } finally {
    if (active) {
      setManageInFlight(manageKey(active), null);
      paintManageUI();
    }
  }
  return data;
}

/**
 * What the answer to a rebalance or re-open request does: the dialog
 * and the optimistic badge while the position it was for is on screen,
 * and the Activity Log entry, naming that position, either way.
 *
 * Exported so a test can drive it with an answer of its own: the request
 * goes through the global `fetch`, which a test must not replace.
 *
 * @param {object} o
 * @param {object} o.data        The server's answer.
 * @param {string} [o.requestKey]  The key of the position it was for.
 * @param {object|null} o.active   That position.
 * @param {object|null} o.inFlight  Another action under way, if any.
 * @param {string} o.url
 * @param {string} o.triggerActLabel
 * @returns {boolean}  Whether the answer was for the screen.
 */
export function _settleRebalanceAnswer({
  data,
  requestKey,
  active,
  inFlight,
  url,
  triggerActLabel,
}) {
  const onScreen = isAnswerForPositionOnScreen(data, requestKey);
  if (data?.ok === true) {
    _handleRebalanceOk(active, inFlight, url, triggerActLabel, onScreen);
    return onScreen;
  }
  // Refused while a scan runs: the dialog on screen waits for it.
  if (data?.scanInProgress === true && onScreen) return onScreen;
  // A re-open refused under the pool rule says which position holds it.
  const refusal = poolRuleRefusal(data);
  if (refusal !== null)
    _showRebalanceError(refusal.title, refusal.text, active, onScreen);
  else
    _showRebalanceError(
      "Rebalance Blocked",
      data?.error || "Unknown error",
      active,
      onScreen,
    );
  return onScreen;
}

/**
 * Rebalance Anyway button — POST /api/rebalance, then close the modal;
 * or, when the server refuses because the position's scan is in
 * progress, keep it open waiting for the scan.
 */
export async function confirmRebalance() {
  const active = posStore.getActive();
  if (!active) {
    closeRebalanceConfirm();
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Rebalance Blocked",
      "<p>No active position selected</p>",
    );
    return;
  }
  const chain = activeChainId();
  const positionKey = compositeKey(
    chain,
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  // One request per click: the button waits for the answer.
  const confirm = g("ilWarnConfirmBtn");
  if (confirm) confirm.disabled = true;
  const data = await _postRebalance(
    "/api/rebalance",
    { positionKey },
    active,
    "Manual Rebalance",
  );
  if (confirm) confirm.disabled = false;
  if (
    data?.scanInProgress === true &&
    isAnswerForPositionOnScreen(data, positionKey)
  ) {
    startScanWait(_scanWait, positionKey, data.error);
    return;
  }
  closeRebalanceConfirm();
}
