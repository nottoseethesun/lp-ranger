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
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import {
  posStore,
  isPositionManaged,
  isPositionClosed,
} from "./dashboard-positions.js";
import {
  _createModal,
  _posContextHtml,
  _posLabel,
  setOptimisticSpecialAction,
  getLastStatus,
  isSyncComplete,
} from "./dashboard-data.js";
import { findActiveAction } from "./dashboard-mission-badge.js";
import { showQueuedActionModal } from "./dashboard-compound.js";
import {
  paintManageUI,
  setManageInFlight,
  manageKey,
} from "./dashboard-manage-ui.js";

/** @private */
function _updateRangeHint() {
  const input = g("rebalanceRangeInput");
  const hint = g("rebalanceRangeHint");
  if (!input || !hint) return;
  const total = parseFloat(input.value);
  const offset = parseInt(g("inOffsetToken0")?.value, 10);
  /*- No literal fallbacks per feedback_one_literal_per_shipped_default:
   *  skip the hint when either input is empty.  The hint repaints once
   *  the user enters a value or AJAX populates the offset input. */
  if (!Number.isFinite(total) || !Number.isFinite(offset)) {
    hint.textContent = "";
    return;
  }
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

/**
 * Open the Rebalance with Updated Range modal.
 *
 * Re-open context (drained position routed here by the closed-position
 * Manage flow) is DERIVED from position state — no flag arg, no DOM
 * attribute — so the modal cannot get out of sync with the position
 * it's targeting.  A closed position bypasses the "must be managed
 * first" / "wait for syncing" gates because (a) it WAS auto-retired
 * so it isn't managed, and (b) the bot loop isn't polling so the sync
 * badge isn't meaningful for it; the only way to reach this modal for
 * a closed position is via `runReopenFlow` in
 * `dashboard-reopen-flow.js`, which already did the dust check and
 * confirmation dialog.
 */
export function openRebalanceRangeModal() {
  const a = posStore.getActive();
  const closed = a && isPositionClosed(a);
  const managed = a && isPositionManaged(a.tokenId);
  /*- Read sync completeness from app state — never from
   *  syncBadge.classList — per [[feedback-no-classlist-for-state]].
   *  `isSyncComplete()` returns null|true|false (the underlying source
   *  of truth that `_updateSyncBadge` also uses to set the class). */
  const synced = isSyncComplete() === true;
  if (!closed && (!managed || !synced)) {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Rebalance Blocked",
      _posContextHtml() +
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
  const ctx = g("rebalanceRangeCtx");
  if (ctx) ctx.innerHTML = _posContextHtml();
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

/*- Read the rebalance range-width input, clamp to a sane range, and
 *  fall back to the project default of 10% if the value is missing,
 *  non-finite, zero, negative, or above the 200% input max.  The HTML
 *  input has `min="0.1" max="200"` but those gates only fire on form
 *  submit — a hand-typed `-5` or `abc` would otherwise reach the
 *  server, and the server's `_stampReopenFlags` silently drops
 *  `<= 0` widths, leaving the bot loop to use its default while the
 *  user thinks their override applied. */
function _readValidRangeWidth() {
  const input = g("rebalanceRangeInput");
  const parsed = parseFloat(input?.value);
  if (!Number.isFinite(parsed)) return 10;
  if (parsed <= 0) return 10;
  if (parsed > 200) return 10;
  return parsed;
}

/** Confirm and trigger a rebalance with the custom range width. */
export async function confirmRebalanceRange() {
  const total = _readValidRangeWidth();
  closeRebalanceRangeModal();
  /*- Disable BOTH buttons synchronously so the user sees feedback the
   *  instant Confirm is clicked.  The manage-button disable is
   *  critical for closed-position re-open: this handler is reached
   *  AFTER _runClosedPositionFlow's `finally` block ran (and cleared
   *  the in-flight flag), so when the user confirms the range modal,
   *  the manage button has just been re-painted as ENABLED (closed +
   *  stopped from stale /api/status).  Without this synchronous
   *  disable, the manage button stays enabled for the entire 4-minute
   *  rebalance window because paintManageUI() returns null while
   *  manageInFlight is set, preserving the prior (enabled) state.
   *  The setManageInFlight call below seals the disable in across
   *  polls; this synchronous write seeds the correct state for the
   *  null-spec path to preserve. */
  const _help =
    "LP Ranger is currently submitting transactions" +
    " to the blockchain to rebalance this LP Position.";
  const _activeForFlag = posStore.getActive();
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
  if (_activeForFlag) {
    setManageInFlight(manageKey(_activeForFlag), true);
  }
  try {
    const active = posStore.getActive();
    if (!active) {
      /*- Intentionally omits position context — fires before any
       *  position is selected, so there is nothing to attribute. */
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
    /*- Re-open path is derived purely from position state: a closed,
     *  not-actively-managed NFT can only have reached this confirm
     *  via `runReopenFlow` (the Rebalance button is disabled for
     *  closed positions; only the closed-position Manage flow leads
     *  here).  Route to `/api/position/manage` with `forceRebalance`
     *  instead of `/api/rebalance` (which rejects for retired
     *  positions because the bot loop isn't running yet).  The
     *  manage endpoint atomically starts the bot loop AND stamps the
     *  rebalance flags so the first poll runs the rebalance pipeline
     *  on the drained NFT. */
    const reopenContext =
      isPositionClosed(active) && !isPositionManaged(active.tokenId);
    const url = reopenContext ? "/api/position/manage" : "/api/rebalance";
    /*- Re-open payload deliberately omits `liquidity`: handleManage's
     *  autoCompound-default branch keys off `body.liquidity === "0"`
     *  and would persist `autoCompoundEnabled: false`.  For a
     *  retired position the disk config already has the field set
     *  from `createOnRetire`, so omitting `liquidity` here is a
     *  no-op for that path; for a cross-machine fresh install
     *  pointed at the same NFT (no prior config), omitting `liquidity`
     *  preserves the default `autoCompoundEnabled: true`, which is
     *  the correct behaviour for an actively-managed re-open. */
    const reqBody = reopenContext
      ? {
          tokenId: active.tokenId,
          contract: active.contractAddress,
          forceRebalance: true,
          customRangeWidthPct: total,
        }
      : { positionKey, customRangeWidthPct: total };
    const res = await fetchWithCsrf(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
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
    setOptimisticSpecialAction("rebalance", {
      tokenId: active.tokenId,
      fee: active.fee,
      token0Symbol: active.token0Symbol,
      token1Symbol: active.token1Symbol,
    });
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
  } finally {
    /*- Always clear the manage in-flight flag so the next poll's
     *  paintManageUI() can transition the button to the steady-state
     *  "Rebalance in progress" disabled view (server-derived) instead
     *  of being stuck on this click's transient optimistic state. */
    if (_activeForFlag) {
      setManageInFlight(manageKey(_activeForFlag), false);
      paintManageUI();
    }
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
