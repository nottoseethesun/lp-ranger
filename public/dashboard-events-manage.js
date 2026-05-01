/**
 * @file dashboard-events-manage.js
 * @description Privacy toggle, pool details modal,
 * manage-position toggle, and copy-button helpers.
 * Split from dashboard-events.js for maintainability.
 */

import {
  g,
  toggleSettingsPopover,
  csrfHeaders,
  copyWithFeedback,
} from "./dashboard-helpers.js";
import { copyText } from "./dashboard-wallet.js";
import { getProviderLabel } from "./dashboard-nft-providers.js";
import { paintChartLinks } from "./dashboard-chart-providers.js";
import { resetHistoryFlag } from "./dashboard-data.js";
import { clearHistory } from "./dashboard-history.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
} from "./dashboard-unmanaged.js";
import { suppressAutoCompoundSync } from "./dashboard-data-status.js";
import { playSound, SOUND_MANAGE_START } from "./dashboard-sounds.js";
import {
  applyPrivacyState,
  forceBothSubOptionsOn,
} from "./dashboard-privacy-subform.js";

// ── Privacy ─────────────────────────────────────────

/**
 * Master privacy toggle handler. Persists the master switch state and
 * re-applies the current combined wallet/USD blur state. Category-level
 * apply logic lives in `dashboard-privacy-subform.js`.
 */
export function _togglePrivacy() {
  const on = g("privacySwitch")?.checked;
  try {
    localStorage.setItem("9mm_privacy_mode", on ? "1" : "0");
  } catch {
    /* */
  }
  if (on) forceBothSubOptionsOn();
  applyPrivacyState();
}

/**
 * Re-apply privacy blur to dynamically rendered content after a status
 * poll updates KPIs or history. Delegates to `applyPrivacyState()` so
 * the USD-threshold sweep re-runs against the fresh DOM text.
 */
export function reapplyPrivacyBlur() {
  if (localStorage.getItem("9mm_privacy_mode") !== "1") return;
  applyPrivacyState();
}

/**
 * Restore privacy mode from localStorage on page load. When the
 * localStorage entry is absent (first visit or after "Clear Local
 * Storage"), falls back to the operator-configured default from
 * `GET /api/ui-defaults` (backed by
 * `app-config/static-tunables/ui-defaults.json`). Fetch failures
 * degrade to "off" so a brand-new browser without server reachability
 * still renders sensitive data (caller explicitly chose to view).
 * @returns {Promise<void>}
 */
export async function restorePrivacyMode() {
  let on = false;
  const saved = localStorage.getItem("9mm_privacy_mode");
  if (saved === "1" || saved === "0") {
    on = saved === "1";
  } else {
    try {
      const res = await fetch("/api/ui-defaults");
      if (res.ok) {
        const data = await res.json();
        if (typeof data.privacyModeEnabled === "boolean")
          on = data.privacyModeEnabled;
      }
    } catch {
      /* keep default off */
    }
  }
  const sw = g("privacySwitch");
  if (sw) sw.checked = on;
  applyPrivacyState();
}

// ── Copy button helper ──────────────────────────────

/**
 * Bind a copy-button adjacent to an element
 * with the given ID.
 * @param {string} id  Target element ID.
 */
export function _bindCopyBtn(id) {
  const el = g(id);
  if (!el) return;
  const btn = el.parentElement?.querySelector(".copy-btn");
  if (btn) btn.addEventListener("click", () => copyText(id));
}

// ── Pool Details modal ──────────────────────────────

/** @type {import('./dashboard-positions.js').PosStore | null} */
let _posStoreRef = null;

/**
 * Inject posStore reference for Pool Details
 * modal (avoids circular dep).
 * @param {object} posStore  Position store.
 */
export function injectPosStoreForEvents(posStore) {
  _posStoreRef = posStore;
}

/**
 * Build a DocumentFragment for an address with an inline copy icon.
 * @param {string} addr  EVM address (0x...).
 * @returns {DocumentFragment}
 */
function _addrWithCopyFrag(addr) {
  const frag = document.createDocumentFragment();
  if (!addr) {
    frag.appendChild(document.createTextNode("\u2014"));
    return frag;
  }
  frag.appendChild(document.createTextNode(addr + " "));
  const icon = document.createElement("span");
  icon.className = "9mm-pos-mgr-copy-icon";
  icon.title = "Copy address";
  icon.setAttribute("data-copy-addr", addr);
  icon.textContent = "\u274F";
  frag.appendChild(icon);
  return frag;
}

/** Build a symbol + (optional) address-with-copy fragment. */
function _tokenCellFrag(sym, addr) {
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(sym || "?"));
  if (addr) {
    frag.appendChild(document.createElement("br"));
    frag.appendChild(document.createTextNode("\u00A0\u00A0\u00A0\u00A0"));
    frag.appendChild(_addrWithCopyFrag(addr));
  }
  return frag;
}

/** Open the pool-details modal for the active position. */
export function _openPoolDetailsModal() {
  const active = _posStoreRef?.getActive?.();
  if (!active) return;
  const m = g("poolDetailsModal");
  if (!m) return;
  const fee = active.fee ? (active.fee / 10000).toFixed(2) + "%" : "\u2014";
  const el = (id, txt) => {
    const e = g(id);
    if (e) e.textContent = txt;
  };
  const elFrag = (id, frag) => {
    const e = g(id);
    if (e) e.replaceChildren(frag);
  };
  el("pdType", active.positionType === "nft" ? "NFT (ERC-721)" : "ERC-20");
  elFrag("pdToken0", _tokenCellFrag(active.token0Symbol, active.token0));
  elFrag("pdToken1", _tokenCellFrag(active.token1Symbol, active.token1));
  el("pdFee", fee);
  el(
    "pdTickSpacing",
    active.tickSpacing ? String(active.tickSpacing) : "\u2014",
  );
  elFrag("pdPool", _addrWithCopyFrag(active.poolAddress));
  const providerLabel = getProviderLabel(active.contractAddress);
  elFrag(
    "pdContract",
    providerLabel
      ? _tokenCellFrag(providerLabel, active.contractAddress)
      : _addrWithCopyFrag(active.contractAddress),
  );
  paintChartLinks(active.poolAddress);
  m.classList.remove("hidden");
}

// ── Reload Current Position ─────────────────────────

/**
 * Abort any in-flight server-side scan for the active position and re-fire
 * its full load from scratch.  User escape hatch for the "Syncing\u2026"
 * badge getting wedged after a stale-CSRF 403 on /api/position/lifetime
 * or similar transient failure where phase 2 was abandoned mid-flight.
 *
 * Flow:
 *   1. POST /api/position/scan-cancel — aborts the event-scanner chunk
 *      loop cooperatively and resets the position's rebalanceScanComplete
 *      flag on the server.
 *   2. resetLastFetchedId() — clears the dashboard-unmanaged entry guard
 *      so the next fetchUnmanagedDetails call does not short-circuit.
 *   3. resetHistoryFlag() — drops the cached rebalance events so the
 *      history table repopulates cleanly on next poll.
 *   4. fetchUnmanagedDetails() — re-fires phase 1 + phase 2 with a fresh
 *      CSRF token.
 *
 * For managed positions the server owns sync state; the same cancel +
 * client reset is still useful and the bot loop will resume its own
 * scan on the next cycle.
 */
export async function _reloadCurrentPosition() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId) return;
  const btn = g("reloadPositionBtn");
  if (btn) btn.disabled = true;
  try {
    const wallet = active.walletAddress;
    const contract = active.contractAddress;
    const key = `pulsechain-${wallet}-${contract}-${active.tokenId}`;
    console.log(
      "[lp-ranger] [reload] user requested reload for #%s",
      active.tokenId,
    );
    try {
      await fetch("/api/position/scan-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          positionKey: key,
          walletAddress: wallet,
          token0: active.token0,
          token1: active.token1,
          fee: active.fee,
        }),
      });
    } catch (err) {
      /*- Network error here is non-fatal. The client-side reset below
       *  will still make the next fetch start fresh; the server-side
       *  scan (if stuck) will naturally clean up on its own timeout. */
      console.warn("[lp-ranger] [reload] scan-cancel failed:", err.message);
    }
    resetHistoryFlag();
    clearHistory();
    resetLastFetchedId();
    fetchUnmanagedDetails(active);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Manage toggle ───────────────────────────────────

/*- Single-flight guard: prevents (a) double-click race firing two POSTs,
 *  and (b) the 3-second status poll's updateManageBadge() from
 *  overwriting the in-flight "Managing\u2026" / "Stopping\u2026" button text
 *  before the request resolves.  Tracked client-side per page (server
 *  has its own `_starting` Set guard for nonce safety). */
let _manageInFlight = false;

/**
 * Format a brief position specification for user-facing failure messages.
 * Returns e.g. "NFT #159289 (HEX/WPLS \u00B7 0.25%)" — falls back to
 * partial fields when symbols/fee aren't yet resolved on `active`.
 *
 * @param {object} active  Active position from posStore.
 * @returns {string}       Formatted spec, or "" when no tokenId is known.
 */
function _formatPositionSpec(active) {
  if (!active || !active.tokenId) return "";
  const t0 = active.token0Symbol;
  const t1 = active.token1Symbol;
  const fee = active.fee ? (active.fee / 10000).toFixed(2) + "%" : null;
  const tokens = t0 && t1 ? `${t0}/${t1}` : null;
  const meta = [tokens, fee].filter(Boolean).join(" \u00B7 ");
  return meta ? `NFT #${active.tokenId} (${meta})` : `NFT #${active.tokenId}`;
}

/**
 * Surface a manage failure to the user without leaving the button stuck.
 * Restores the button text and shows an actionable alert that names the
 * specific position and tells the user how to retry.
 *
 * When the server reason indicates an RPC-side failure, the retry hint
 * also tells the user the bot has already engaged sticky failover — so
 * the next click hits the backup RPC immediately instead of repeating
 * the same dead-RPC walk.  See `src/bot-loop-detect.js`.
 *
 * @param {string} verb    Human verb for the message ("manage"/"unmanage").
 * @param {string} reason  Short reason from server or thrown error.
 * @param {object} [active] Active position (for the spec line).
 */
function _handleManageFailure(verb, reason, active) {
  console.warn("[lp-ranger] [manage] %s failed: %s", verb, reason);
  // Restore the button immediately. updateManageBadge will
  // re-paint correct text on the next status poll (3s).
  const btn = g("manageToggleBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = verb === "manage" ? "Manage" : "Stop Managing";
  }
  const spec = _formatPositionSpec(active);
  const action = verb === "manage" ? "start managing" : "stop managing";
  const buttonLabel = verb === "manage" ? "Manage" : "Stop Managing";
  /*- The bot-loop-detect retry chain engages sticky RPC failover on
   *  every miss, so by the time the server returns "No V3 NFT position
   *  found" the next attempt is already routed through the backup. */
  const looksLikeRpcFailure = /No V3 NFT position found|RPC failure/i.test(
    reason || "",
  );
  const retryHint = looksLikeRpcFailure
    ? `\n\nClick "${buttonLabel}" again to retry \u2014 the bot has already failed over to the backup RPC.`
    : `\n\nClick "${buttonLabel}" again to retry.`;
  /*- alert() is intentional here — the manage flow is a deliberate user
   *  action and silent failure is what got us into the stuck-UI state
   *  this branch is fixing. */
  alert(`Couldn't ${action}${spec ? " " + spec : ""}:\n${reason}${retryHint}`);
}

/** Send the DELETE request to stop managing `active`. */
async function _sendUnmanage(active) {
  const key = `pulsechain-${active.walletAddress}-${active.contractAddress}-${active.tokenId}`;
  // Suppress poll-driven auto-compound sync so it doesn't race back on
  suppressAutoCompoundSync(5000);
  const res = await fetch("/api/position/manage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    _handleManageFailure(
      "unmanage",
      body.error || `HTTP ${res.status}`,
      active,
    );
    return false;
  }
  // Turn off auto-compound UI
  const acCb = g("autoCompoundToggle");
  if (acCb) acCb.checked = false;
  const acBadge = g("autoCompoundBadge");
  if (acBadge) acBadge.textContent = "OFF";
  // Position is now unmanaged — trigger unmanaged detail fetch
  // so the sync badge resolves and KPIs stay populated.
  resetLastFetchedId();
  fetchUnmanagedDetails(active);
  return true;
}

/** Send the POST request to start managing `active`. */
async function _sendManage(active) {
  playSound(SOUND_MANAGE_START);
  const res = await fetch("/api/position/manage", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({
      tokenId: active.tokenId,
      contract: active.contractAddress,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    _handleManageFailure("manage", body.error || `HTTP ${res.status}`, active);
    return false;
  }
  console.log("[lp-ranger] [manage] started managing #%s", active.tokenId);
  return true;
}

/** Toggle manage / pause for the active NFT position. */
export async function _toggleManagePosition() {
  if (_manageInFlight) {
    console.log("[lp-ranger] [manage] click ignored — request in-flight");
    return;
  }
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId || active.positionType !== "nft") return;
  const badge = g("manageBadge");
  const btn = g("manageToggleBtn");
  const isManaged = badge?.classList.contains("managed");
  /* Clear stale history so the next poll
     renders data for the correct position. */
  clearHistory();
  resetHistoryFlag();

  _manageInFlight = true;
  // Disable + re-label the button synchronously so a fast second click
  // can't fire a second request before the in-flight flag is set.
  if (btn) {
    btn.disabled = true;
    btn.textContent = isManaged ? "Stopping\u2026" : "Managing\u2026";
  }

  try {
    if (isManaged) await _sendUnmanage(active);
    else await _sendManage(active);
  } catch (err) {
    /*- Network error (fetch reject) — distinct from HTTP 4xx/5xx above. */
    _handleManageFailure(
      isManaged ? "unmanage" : "manage",
      err.message,
      active,
    );
  } finally {
    _manageInFlight = false;
  }
}

/**
 * Update the manage badge based on managed
 * positions from status poll.
 * @param {Array} managedList  Managed positions.
 * @param {string} activeTokenId  Active ID.
 */
export function updateManageBadge(
  managedList,
  activeTokenId,
  rebalanceInProgress,
) {
  const badge = g("manageBadge");
  if (!badge) return;
  const btn = g("manageToggleBtn");
  if (!btn) return;
  const isManaged =
    Array.isArray(managedList) &&
    managedList.some(
      (p) =>
        String(p.tokenId) === String(activeTokenId) && p.status === "running",
    );
  badge.classList.toggle("managed", isManaged);
  if (isManaged) {
    const dot = document.createElement("span");
    dot.className = "9mm-pos-mgr-manage-dot";
    badge.replaceChildren(
      dot,
      document.createTextNode("Being Actively Managed"),
    );
  } else {
    badge.textContent = "Not Actively Managed";
  }
  /*- Don't clobber the in-flight "Managing\u2026" / "Stopping\u2026"
   *  text that the click handler just set — the next poll after the
   *  request resolves will repaint correctly. */
  if (_manageInFlight) return;
  if (rebalanceInProgress) {
    btn.textContent = "Rebalancing\u2026";
  } else {
    btn.textContent = isManaged ? "Stop Managing" : "Manage";
  }
}

// ── Delegated events + Escape ───────────────────

/**
 * Bind event delegation for dynamically
 * generated elements plus the Escape-key
 * modal dismiss handler. Extracted from
 * bindAllEvents to keep the main file
 * within line-count limits.
 * @param {object} closers  Modal close fns.
 */
export function bindDelegatedEvents(closers) {
  for (const id of ["rebEventsBody", "actList"]) {
    const el = g(id);
    if (el)
      el.addEventListener("click", (e) => {
        const ic = e.target.closest("[data-copy-tx]");
        if (ic) copyWithFeedback(ic, ic.dataset.copyTx);
      });
  }

  const sg = document.querySelector(".stat-grid");
  if (sg)
    sg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy-addr]");
      if (b) copyWithFeedback(b, b.dataset.copyAddr);
    });

  const pdm = g("poolDetailsModal");
  if (pdm)
    pdm.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy-addr]");
      if (b) copyWithFeedback(b, b.dataset.copyAddr);
    });

  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dismiss-modal]");
    if (b) {
      const ov = b.closest('[class*="modal-overlay"]');
      if (ov) ov.remove();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // The IL/G debug popover is created and removed dynamically (no
    // hidden class), so checking for its presence in the DOM is enough.
    const ilPop = g("9mm-il-debug-popover");
    if (ilPop && closers.ilDebug) {
      closers.ilDebug();
      return;
    }
    const modals = [
      {
        id: "walletModal",
        close: closers.walletModal,
      },
      {
        id: "posBrowserModal",
        close: closers.posBrowser,
      },
      {
        id: "revealModal",
        close: closers.revealModal,
      },
      {
        id: "clearWalletModal",
        close: closers.clearWallet,
      },
      {
        id: "rebalanceRangeModal",
        close: closers.rebalanceRange,
      },
      {
        id: "throttleInfoModal",
        close: closers.throttleInfo,
      },
      {
        id: "poolDetailsModal",
        close: () => {
          const m = g("poolDetailsModal");
          if (m) m.classList.add("hidden");
        },
      },
      {
        id: "donateOverlay",
        close: closers.donate,
      },
      {
        id: "aboutOverlay",
        close: closers.about,
      },
    ];
    for (const m of modals) {
      const el = g(m.id);
      if (el && !el.classList.contains("hidden")) {
        m.close();
        return;
      }
    }
    const dyn = document.querySelector('[class*="pos-mgr-modal-overlay"]');
    if (dyn) {
      dyn.remove();
      return;
    }
    const sp = g("settingsPopover");
    if (sp && sp.classList.contains("9mm-pos-mgr-visible"))
      toggleSettingsPopover();
  });

  document.addEventListener("click", (e) => {
    const sp = g("settingsPopover");
    if (
      sp &&
      sp.classList.contains("9mm-pos-mgr-visible") &&
      !e.target.closest('[class*="pos-mgr-settings-wrap"]')
    )
      toggleSettingsPopover();
  });
}
