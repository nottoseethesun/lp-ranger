/**
 * @file dashboard-throttle-rebalance.js
 * @description Rebalance with Updated Range modal: open, close, confirm,
 * and range hint display. Split from dashboard-throttle.js.
 */
import {
  g,
  act,
  ACT_ICONS,
  compositeKey,
  csrfHeaders,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import {
  _createModal,
  _posContextHtml,
  _posLabel,
  setOptimisticSpecialAction,
  getLastStatus,
} from "./dashboard-data.js";
import { findActiveAction } from "./dashboard-mission-badge.js";
import { showQueuedActionModal } from "./dashboard-compound.js";

/** @private */
function _updateRangeHint() {
  const input = g("rebalanceRangeInput");
  const hint = g("rebalanceRangeHint");
  if (!input || !hint) return;
  const total = parseFloat(input.value) || 10;
  const offset = parseInt(g("inOffsetToken0")?.value, 10) || 50;
  if (offset === 50) {
    const half = (total / 2).toFixed(3).replace(/\.?0+$/, "");
    hint.textContent = `${half}% on either side of the current price`;
  } else {
    const below = ((total * (100 - offset)) / 100)
      .toFixed(3)
      .replace(/\.?0+$/, "");
    const above = ((total * offset) / 100).toFixed(3).replace(/\.?0+$/, "");
    const a = posStore.getActive();
    const t0 = a?.token0Symbol || "Token 0";
    const t1 = a?.token1Symbol || "Token 1";
    hint.textContent = `${below}% below / ${above}% above current price (${offset}% ${t0} / ${100 - offset}% ${t1})`;
  }
}

/** Open the Rebalance with Updated Range modal. */
export function openRebalanceRangeModal() {
  const a = posStore.getActive();
  const managed = a && isPositionManaged(a.tokenId);
  const synced = g("syncBadge")?.classList.contains("done");
  if (!managed || !synced) {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Rebalance Blocked",
      "<p>" +
        (!managed
          ? "Click Manage first, then wait" + " for syncing to finish."
          : "Wait for syncing" + " to finish before rebalancing.") +
        "</p>",
    );
    return;
  }
  const modal = g("rebalanceRangeModal");
  if (modal) modal.classList.remove("hidden");
  _updateRangeHint();
}

/** Close the Rebalance with Updated Range modal. */
export function closeRebalanceRangeModal() {
  const m = g("rebalanceRangeModal");
  if (m) m.classList.add("hidden");
}

/** Update the hint text showing per-side percentage. */
export function updateRebalanceRangeHint() {
  _updateRangeHint();
}

/** Confirm and trigger a rebalance with the custom range width. */
export async function confirmRebalanceRange() {
  const input = g("rebalanceRangeInput");
  const total = parseFloat(input?.value) || 10;
  closeRebalanceRangeModal();
  /* Disable buttons immediately so the user sees feedback before the fetch. */
  const _help =
    "LP Ranger is currently submitting transactions" +
    " to the blockchain to rebalance this LP Position.";
  const _btn = g("manageToggleBtn");
  const _rebBtn = g("rebalanceWithRangeBtn");
  if (_btn) {
    _btn.disabled = true;
    _btn.title = _help;
  }
  if (_rebBtn) {
    _rebBtn.disabled = true;
    _rebBtn.title = _help;
  }
  try {
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
    const inFlight = findActiveAction(getLastStatus()?._allPositionStates);
    const res = await fetch("/api/rebalance", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ positionKey, customRangeWidthPct: total }),
    });
    const data = await res.json();
    if (!data.ok) {
      _createModal(
        null,
        "9mm-pos-mgr-modal-caution",
        "Rebalance Blocked",
        _posContextHtml() + "<p>" + (data.error || "Unknown error") + "</p>",
      );
      const _p = _posLabel();
      act(
        ACT_ICONS.warn,
        "alert",
        "Rebalance Blocked",
        data.error + (_p ? "\n" + _p : ""),
      );
      return;
    }
    setOptimisticSpecialAction("rebalance");
    if (inFlight) showQueuedActionModal("rebalance", inFlight);
  } catch {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Rebalance Failed",
      _posContextHtml() + "<p>Server unreachable</p>",
    );
    const _p = _posLabel();
    act(
      ACT_ICONS.warn,
      "alert",
      "Rebalance Failed",
      "Server unreachable" + (_p ? "\n" + _p : ""),
    );
    return;
  }
  const _pl = _posLabel();
  act(
    ACT_ICONS.swap,
    "start",
    "Rebalance with Custom Range",
    `Total width: ${total}% (${(total / 2).toFixed(3).replace(/\.?0+$/, "")}% per side)` +
      (_pl ? "\n" + _pl : ""),
  );
}
