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
  _posLabel,
} from "./dashboard-data-status.js";
import { setOptimisticSpecialAction, getLastStatus } from "./dashboard-data.js";
import { findActiveAction } from "./dashboard-mission-badge.js";
import { showQueuedActionModal } from "./dashboard-compound.js";
import {
  paintManageUI,
  setManageInFlight,
  manageKey,
} from "./dashboard-manage-ui.js";

/*- "preserveRange width" as % — the width the rebalancer would
 *  produce for a position with the given tick spread + Position
 *  Offset.  Matches `src/range-math.js:preserveRange()` +
 *  `src/rebalancer.js:294-298`:
 *      belowTicks = spread * (100 - offset) / 100
 *      aboveTicks = spread * offset / 100
 *      widthPct   = (1.0001^aboveTicks - 1.0001^(-belowTicks)) * 100
 *  For offset=50 (centered) this simplifies to the symmetric form;
 *  for other offsets the exponents differ (asymmetric range).
 *  INDEPENDENT of `currentPrice` — pure function of (spread, offset).
 *  Returns a two-decimal string or null when inputs are missing /
 *  non-finite. */
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

/*- Compact "X%" range-width value for the modal's position-context
 *  data-list line.  Pulls from getLastStatus() — the same source the
 *  Bot Settings row's `_syncRangeWidth` reads on every poll, so the
 *  preview matches what a subsequent rebalance will actually apply.
 *  A pre-populated but unsaved input value does NOT influence this —
 *  only the saved config value or the preserveRange fallback.  Offset
 *  is read from the same status payload (falls back to 50 centered
 *  if unset) so the value accounts for non-centered Position Offset
 *  configurations.  Returns an em-dash when neither source yields a
 *  finite value. */
export function _rangeWidthPreviewText(status, active) {
  /*- Full-Range checkbox wins over any saved Price Range Extension —
   *  the rebalance will mint at MIN_TICK / MAX_TICK via
   *  rangeMath.fullRange().  Show "Full-Range" rather than a numeric
   *  percentage so the user isn't surprised by an astronomically wide
   *  mint. */
  if (status?.fullRangeRebalanceEnabled === true) {
    return "Full-Range";
  }
  const saved = status?.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    return String(saved) + "%";
  }
  const rawOffset = status?.offsetToken0Pct;
  const offset =
    rawOffset !== undefined &&
    rawOffset !== null &&
    Number.isFinite(rawOffset) &&
    rawOffset >= 0 &&
    rawOffset <= 100
      ? rawOffset
      : 50;
  const preserved = _computePreservedWidthPct(
    active?.tickLower,
    active?.tickUpper,
    offset,
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
  const m = g("rebalanceIlWarningModal");
  if (m) m.classList.add("hidden");
}

/** Optimistically disable the Manage + Rebalance buttons for the
 *  duration of the in-flight POST so the user sees feedback
 *  immediately.  Copies the exact tooltip text the old
 *  `confirmRebalanceRange` used. */
function _disableActionButtonsForInFlight() {
  const _help =
    "LP Ranger is currently submitting transactions" +
    " to the blockchain to rebalance this LP Position.";
  const _btn = g("manageToggleBtn");
  if (_btn) {
    _btn.disabled = true;
    _btn.title = _help;
  }
  const _rebBtn = g("rebalanceWithRangeBtn");
  if (_rebBtn) {
    _rebBtn.disabled = true;
    _rebBtn.title = _help;
  }
}

/** Render the "Rebalance Blocked / Failed" caution modal + activity
 *  log entry.  Shared by the response-not-ok and network-exception
 *  branches. */
function _showRebalanceError(title, detail) {
  _createModal(
    null,
    "9mm-pos-mgr-modal-caution",
    title,
    _posContextHtml() + "<p>" + detail + "</p>",
  );
  const _p = _posLabel();
  act(ACT_ICONS.warn, "alert", title, detail + (_p ? "\n" + _p : ""));
}

/** Handle a 200 OK response: optimistic action + queued-action modal
 *  + activity log entry. */
function _handleRebalanceOk(active, inFlight, url, triggerActLabel) {
  if (active) {
    setOptimisticSpecialAction("rebalance", {
      tokenId: active.tokenId,
      fee: active.fee,
      token0Symbol: active.token0Symbol,
      token1Symbol: active.token1Symbol,
    });
  }
  if (inFlight) showQueuedActionModal("rebalance", inFlight);
  const _pl = _posLabel();
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
 */
export async function _postRebalance(url, body, active, triggerActLabel) {
  _disableActionButtonsForInFlight();
  if (active) setManageInFlight(manageKey(active), true);
  const inFlight = findActiveAction(getLastStatus()?._allPositionStates);
  try {
    const res = await fetchWithCsrf(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      _showRebalanceError("Rebalance Blocked", data.error || "Unknown error");
      return;
    }
    _handleRebalanceOk(active, inFlight, url, triggerActLabel);
  } catch {
    _showRebalanceError("Rebalance Failed", "Server unreachable");
  } finally {
    if (active) {
      setManageInFlight(manageKey(active), false);
      paintManageUI();
    }
  }
}

/** Rebalance Anyway button — close modal + POST /api/rebalance. */
export async function confirmRebalance() {
  closeRebalanceConfirm();
  const active = posStore.getActive();
  if (!active) {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Rebalance Blocked",
      "<p>No active position selected</p>",
    );
    return;
  }
  const positionKey = compositeKey(
    "pulsechain",
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  await _postRebalance(
    "/api/rebalance",
    { positionKey },
    active,
    "Manual Rebalance",
  );
}
