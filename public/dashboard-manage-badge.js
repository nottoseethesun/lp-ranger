/**
 * @file dashboard-manage-badge.js
 * @description Manage-badge UI helpers split from
 *   dashboard-positions-store.js for line-count
 *   compliance. Contains the per-activation badge
 *   refresh and the Lifetime panel visibility toggle —
 *   both pivot on the active position's managed status,
 *   so they live in the same module.
 *
 * Lifetime figures (Net P&L, breakdown, Profit, IL,
 * Total Lifetime Deposit, Realized Gains) only make
 * sense for positions the bot is tracking over time.
 * For unmanaged positions we keep the panel's exact
 * dimensions (visibility:hidden + absolute overlay)
 * so the page layout never reflows on Manage / Stop
 * transitions. CSS hooks live in `9mm-pos-mgr.css`
 * under "Lifetime panel".
 *
 * Called by `refreshManageBadge` (position activation
 * path) and by `updateManageBadge` (status-poll path)
 * so both transitions converge on the same UI state.
 */

import { g } from "./dashboard-helpers.js";
import {
  isPositionClosed,
  isPositionManaged,
} from "./dashboard-positions-store.js";

/**
 * Toggle the Lifetime panel between live content and the centered
 * "Click Manage to get reporting of Lifetime values." placeholder.
 *
 * @param {boolean} isManaged  Whether the active position is managed.
 */
export function applyLifetimeUnmanagedUI(isManaged) {
  const content = g("ltContent");
  const placeholder = g("ltUnmanagedPlaceholder");
  if (!content || !placeholder) return;
  content.classList.toggle("9mm-pos-mgr-lt-hidden", !isManaged);
  placeholder.hidden = isManaged;
}

/** Refresh the manage badge for a position. Passing a null/undefined
 *  active resets the button + badge to the default "no managed position"
 *  state, used after the LP Browser Remove drops the last entry — the
 *  3-second status poll skips updateManageBadge when posStore.getActive()
 *  is null, so without this reset the button stays stuck on whatever
 *  the previous poll wrote (most visibly: "Rebalancing…"). */
export function refreshManageBadge(active) {
  const badge = g("manageBadge"),
    btn = g("manageToggleBtn"),
    pdBtn = g("poolDetailsBtn");
  if (!badge || !btn) return;
  if (!active) {
    badge.classList.remove("managed");
    badge.textContent = "Not Actively Managed";
    btn.textContent = "Manage";
    btn.disabled = true;
    btn.title = "Select a position first";
    if (pdBtn) {
      pdBtn.disabled = true;
      pdBtn.title = "Select a position first";
    }
    applyLifetimeUnmanagedUI(false);
    return;
  }
  const closed = isPositionClosed(active);
  const m = !closed && isPositionManaged(active.tokenId);
  badge.classList.toggle("managed", m);
  if (closed) {
    badge.textContent = "Position Closed";
  } else if (m) {
    const dot = document.createElement("span");
    dot.className = "9mm-pos-mgr-manage-dot";
    badge.replaceChildren(
      dot,
      document.createTextNode("Being Actively Managed"),
    );
  } else {
    badge.textContent = "Not Actively Managed";
  }
  btn.textContent = m ? "Stop Managing" : "Manage";
  btn.disabled = closed;
  btn.title = closed ? "Cannot manage a closed position (liquidity = 0)" : "";
  if (pdBtn) {
    pdBtn.disabled = false;
    pdBtn.title = "View pool and contract details";
  }
  applyLifetimeUnmanagedUI(m);
}
