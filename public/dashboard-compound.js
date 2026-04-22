/**
 * @file dashboard-compound.js
 * @description Compound button handlers, auto-compound toggle, and threshold
 * save for the Mission Control panel.
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
  _posLabel,
  _posContextHtml,
  setOptimisticSpecialAction,
  getLastStatus,
} from "./dashboard-data.js";
import { findActiveAction } from "./dashboard-mission-badge.js";
import { truncName } from "./dashboard-helpers.js";

/**
 * Show a small modal telling the user their action is queued behind
 * an in-flight blockchain transaction. Same-wallet nonce serialization
 * means only one TX at a time, so click-while-busy → queue.
 * @param {"compound"|"rebalance"} requested  The action the user just clicked.
 * @param {object} inFlight  {kind, tokenId, token0Symbol, token1Symbol}
 */
export function showQueuedActionModal(requested, inFlight) {
  const reqLabel = requested === "compound" ? "Compound" : "Rebalance";
  const inLabel = inFlight.kind === "compound" ? "compound" : "rebalance";
  const t0 = truncName(inFlight.token0Symbol || "?", 12);
  const t1 = truncName(inFlight.token1Symbol || "?", 12);
  _createModal(
    null,
    "9mm-pos-mgr-modal-help",
    `${reqLabel} Queued`,
    _posContextHtml() +
      `<p>Your ${reqLabel.toLowerCase()} request has been queued.</p>` +
      `<p>It will run after the current in-flight ${inLabel} ` +
      `transaction on Position #${inFlight.tokenId} (${t0}/${t1}) ` +
      `finishes.</p>`,
  );
}

/**
 * Request a manual compound via the server API.
 * Same pattern as confirmRebalanceRange in dashboard-throttle-rebalance.js.
 */
export async function compoundNow() {
  const a = posStore.getActive();
  if (!a || !isPositionManaged(a.tokenId)) {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Compound Blocked",
      _posContextHtml() +
        "<p>Click Manage first, then wait for syncing to finish.</p>",
    );
    return;
  }
  const positionKey = compositeKey(
    "pulsechain",
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
  const inFlight = findActiveAction(getLastStatus()?._allPositionStates);
  try {
    const res = await fetch("/api/compound", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ positionKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      _createModal(
        null,
        "9mm-pos-mgr-modal-caution",
        "Compound Blocked",
        _posContextHtml() + "<p>" + (data.error || "Unknown error") + "</p>",
      );
      return;
    }
    setOptimisticSpecialAction("compound");
    if (inFlight) showQueuedActionModal("compound", inFlight);
  } catch {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Compound Failed",
      _posContextHtml() + "<p>Server unreachable</p>",
    );
    return;
  }
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Compound Requested",
    "Collecting fees and re-depositing as liquidity" + (pl ? "\n" + pl : ""),
  );
}

/**
 * Toggle auto-compound on/off and persist to server config.
 */
export function toggleAutoCompound() {
  const cb = g("autoCompoundToggle");
  if (!cb) return;
  const a = posStore.getActive();
  if (!a || !isPositionManaged(a.tokenId)) {
    cb.checked = false;
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Auto-compound Blocked",
      _posContextHtml() +
        "<p>Click Manage first, then wait for syncing to finish.</p>",
    );
    return;
  }
  const enabled = cb.checked;
  const badge = g("autoCompoundBadge");
  if (badge) {
    badge.textContent = enabled ? "ON" : "OFF";
    badge.className = "9mm-pos-mgr-mission-badge " + (enabled ? "on" : "off");
  }
  const positionKey = compositeKey(
    "pulsechain",
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ autoCompoundEnabled: enabled, positionKey }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Auto-compound " + (enabled ? "Enabled" : "Disabled"),
    pl || "",
  );
}

/**
 * Save the auto-compound threshold with validation.
 * Rejects values below the minimum fee threshold.
 * @param {number} minFee  Minimum fee from server config (default 1).
 */
export function saveCompoundThreshold(minFee) {
  const el = g("autoCompoundThreshold");
  if (!el) return;
  const val = parseFloat(el.value);
  const min = minFee || 1;
  if (!Number.isFinite(val) || val < min) {
    el.value = min;
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Invalid Threshold",
      _posContextHtml() +
        "<p>Auto-compound threshold must be at least $" +
        min.toFixed(2) +
        " (the minimum fee required to compound).</p>",
    );
    return;
  }
  const a = posStore.getActive();
  const positionKey = a
    ? compositeKey("pulsechain", a.walletAddress, a.contractAddress, a.tokenId)
    : undefined;
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ autoCompoundThresholdUsd: val, positionKey }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    "autoCompoundThresholdUsd = " + val + (pl ? "\n" + pl : ""),
  );
}
