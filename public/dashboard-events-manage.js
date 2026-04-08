/**
 * @file dashboard-events-manage.js
 * @description Privacy toggle, pool details modal,
 * manage-position toggle, and copy-button helpers.
 * Split from dashboard-events.js for maintainability.
 */

import {
  g,
  toggleHelpPopover,
  toggleSettingsPopover,
} from "./dashboard-helpers.js";
import { copyText } from "./dashboard-wallet.js";
import { resetHistoryFlag } from "./dashboard-data.js";
import { clearHistory } from "./dashboard-history.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
} from "./dashboard-unmanaged.js";

// ── Privacy ─────────────────────────────────────────

/**
 * IDs of elements that show sensitive
 * addresses / NFT IDs.
 */
const _PRIVACY_TARGETS = [
  "wsAddr",
  "wsToken",
  "headerWalletLabel",
  "genAddr",
  "genKey",
  "genMnemonic",
  "revealAddr",
  "revealKey",
  "revealMnemonic",
  "seedValidAddr",
  "keyValidAddr",
];

/** CSS selectors for privacy-sensitive content. */
const _PRIVACY_SELECTORS = [
  ".pos-row-title",
  ".pos-row-meta",
  '[data-privacy="blur"]',
  ".adt",
];

/**
 * Toggle privacy blur on/off based on the
 * privacy switch checkbox state.
 */
export function _togglePrivacy() {
  const on = g("privacySwitch")?.checked;
  const cls = "9mm-pos-mgr-privacy-blur";
  for (const id of _PRIVACY_TARGETS) {
    const el = g(id);
    if (el) el.classList.toggle(cls, on);
  }
  for (const sel of _PRIVACY_SELECTORS)
    document
      .querySelectorAll(sel)
      .forEach((el) => el.classList.toggle(cls, on));
  const icon = g("privacyIcon");
  if (icon) icon.classList.toggle("9mm-pos-mgr-privacy-active", on);
  try {
    localStorage.setItem("9mm_privacy_mode", on ? "1" : "0");
  } catch {
    /* */
  }
}

/**
 * Re-apply privacy blur to dynamically rendered
 * content.  Call after DOM updates.
 */
export function reapplyPrivacyBlur() {
  if (localStorage.getItem("9mm_privacy_mode") !== "1") return;
  const cls = "9mm-pos-mgr-privacy-blur";
  for (const id of _PRIVACY_TARGETS) {
    const el = g(id);
    if (el) el.classList.add(cls);
  }
  for (const sel of _PRIVACY_SELECTORS)
    document.querySelectorAll(sel).forEach((el) => el.classList.add(cls));
}

/**
 * Restore privacy mode from localStorage on
 * page load.
 */
export function restorePrivacyMode() {
  const on = localStorage.getItem("9mm_privacy_mode") === "1";
  const sw = g("privacySwitch");
  if (sw) sw.checked = on;
  if (on) _togglePrivacy();
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
  el("pdType", active.positionType === "nft" ? "NFT (ERC-721)" : "ERC-20");
  const t0 = g("pdToken0");
  if (t0) {
    t0.textContent = active.token0Symbol || "?";
    if (active.token0) {
      t0.appendChild(document.createElement("br"));
      t0.appendChild(
        document.createTextNode("\u00A0\u00A0\u00A0\u00A0" + active.token0),
      );
    }
  }
  const t1 = g("pdToken1");
  if (t1) {
    t1.textContent = active.token1Symbol || "?";
    if (active.token1) {
      t1.appendChild(document.createElement("br"));
      t1.appendChild(
        document.createTextNode("\u00A0\u00A0\u00A0\u00A0" + active.token1),
      );
    }
  }
  el("pdFee", fee);
  el("pdPool", active.poolAddress || "\u2014");
  el("pdContract", active.contractAddress || "\u2014");
  m.classList.remove("hidden");
}

// ── Manage toggle ───────────────────────────────────

/** Toggle manage / pause for the active NFT position. */
export function _toggleManagePosition() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId || active.positionType !== "nft") return;
  const badge = g("manageBadge");
  const isManaged = badge?.classList.contains("managed");
  /* Clear stale history so the next poll
     renders data for the correct position. */
  clearHistory();
  resetHistoryFlag();

  if (isManaged) {
    // Build composite key and stop managing
    const w = _posStoreRef.getActive()?.walletAddress;
    const c = active.contractAddress;
    const key = `pulsechain-${w}-${c}-` + `${active.tokenId}`;
    fetch("/api/position/manage", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key }),
    })
      .then(() => {
        // Position is now unmanaged — trigger unmanaged detail fetch
        // so the sync badge resolves and KPIs stay populated.
        resetLastFetchedId();
        fetchUnmanagedDetails(active);
      })
      .catch(() => {});
  } else {
    fetch("/api/position/manage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tokenId: active.tokenId,
        contract: active.contractAddress,
      }),
    })
      .then(() => {
        const btn = g("manageToggleBtn");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Managing\u2026";
        }
      })
      .catch(() => {});
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
  badge.innerHTML = isManaged
    ? '<span class="9mm-pos-mgr-manage-dot">' + "</span>Being Actively Managed"
    : "Not Actively Managed";
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
        if (ic)
          navigator.clipboard.writeText(ic.dataset.copyTx).catch(() => {});
      });
  }

  const sg = document.querySelector(".stat-grid");
  if (sg)
    sg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy-addr]");
      if (b) {
        navigator.clipboard.writeText(b.dataset.copyAddr).catch(() => {});
        b.textContent = "\u2713";
        setTimeout(() => {
          b.textContent = "\u274F";
        }, 1200);
      }
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
    const hp = g("helpPopover");
    if (hp && hp.classList.contains("9mm-pos-mgr-visible")) {
      toggleHelpPopover();
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
      !e.target.closest(".9mm-pos-mgr-settings-wrap")
    )
      toggleSettingsPopover();
  });
}
