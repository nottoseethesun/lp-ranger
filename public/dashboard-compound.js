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
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions-store.js";
import { saveConfigValues } from "./dashboard-config-save.js";
import {
  _createModal,
  _posLabel,
  _posContextHtml,
} from "./dashboard-data-status.js";
import { getLastStatus } from "./dashboard-data.js";
import {
  findActiveAction,
  setOptimisticSpecialAction,
} from "./dashboard-mission-badge.js";
import { truncName } from "./dashboard-helpers.js";
import { formatSettingChange } from "./dashboard-setting-labels.js";
import { activeChainId } from "./dashboard-chain.js";

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
 * Same pattern as `_postRebalance` in dashboard-rebalance-confirm.js.
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
  const chain = activeChainId();
  const positionKey = compositeKey(
    chain,
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
  const inFlight = findActiveAction(getLastStatus()?._allPositionStates);
  /*-
   *  Named now, for the position clicked: the answer comes back later,
   *  by which time another position may be on screen.
   */
  const ctxHtml = _posContextHtml();
  const pl = _posLabel();
  try {
    const res = await fetchWithCsrf("/api/compound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionKey }),
    });
    const data = await res.json();
    if (!data.ok) {
      _createModal(
        null,
        "9mm-pos-mgr-modal-caution",
        "Compound Blocked",
        ctxHtml + "<p>" + (data.error || "Unknown error") + "</p>",
      );
      return;
    }
    setOptimisticSpecialAction("compound", {
      tokenId: a.tokenId,
      fee: a.fee,
      token0Symbol: a.token0Symbol,
      token1Symbol: a.token1Symbol,
    });
    if (inFlight) showQueuedActionModal("compound", inFlight);
  } catch {
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Compound Failed",
      ctxHtml + "<p>Server unreachable</p>",
    );
    return;
  }
  act(
    ACT_ICONS.acorn,
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
  const chain = activeChainId();
  const positionKey = compositeKey(
    chain,
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
  /*-
   *  Labelled now, for the position clicked: the save answers later, by
   *  which time another position may be on screen. Logged only once the
   *  server has the setting, so the Activity Log never reports a change
   *  the server did not take; a poll then shows the toggle as it is.
   */
  const pl = _posLabel();
  saveConfigValues({
    values: { autoCompoundEnabled: enabled },
    positionKey,
    onSaved: () =>
      act(
        ACT_ICONS.gear,
        "start",
        "Auto-compound " + (enabled ? "Enabled" : "Disabled"),
        pl,
      ),
  });
}

/**
 * Save the auto-compound threshold. Whether the figure is acceptable —
 * at least the fee a compound needs to be worth its gas — is decided by
 * `src/config-bounds.js` on the server.
 */
export function saveCompoundThreshold() {
  const el = g("autoCompoundThreshold");
  if (!el) return;
  const val = parseFloat(el.value);
  const a = posStore.getActive();
  const chain = activeChainId();
  const positionKey = a
    ? compositeKey(chain, a.walletAddress, a.contractAddress, a.tokenId)
    : undefined;
  // Labelled now, for the position clicked, not whichever is on screen later.
  const pl = _posLabel();
  saveConfigValues({
    values: { autoCompoundThresholdUsd: val },
    positionKey,
    inputs: { autoCompoundThresholdUsd: "autoCompoundThreshold" },
    onSaved: () => {
      act(
        ACT_ICONS.gear,
        "start",
        "Setting Saved",
        formatSettingChange("autoCompoundThresholdUsd", val) +
          (pl ? "\n" + pl : ""),
      );
    },
  });
}
