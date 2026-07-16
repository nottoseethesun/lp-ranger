/**
 * @file dashboard-events-manage.js
 * @description Privacy toggle, pool details modal,
 * manage-position toggle, and copy-button helpers.
 * Split from dashboard-events.js for maintainability.
 */

import { log } from "./dashboard-log.js";
import {
  g,
  toggleSettingsPopover,
  fetchWithCsrf,
  copyWithFeedback,
  botConfig,
} from "./dashboard-helpers.js";
import { copyText } from "./dashboard-wallet.js";
import { isPositionClosed } from "./dashboard-positions-store.js";
import { runReopenFlow } from "./dashboard-reopen-flow.js";
import { getProviderLabel } from "./dashboard-nft-providers.js";
import { paintChartLinks } from "./dashboard-chart-providers.js";
import { resetHistoryFlag, isSyncComplete } from "./dashboard-data.js";
import { clearHistory } from "./dashboard-history.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
} from "./dashboard-unmanaged.js";
import { populateRangeWidthFromActive } from "./dashboard-data-range-width.js";
import {
  suppressAutoCompoundSync,
  _createModal,
} from "./dashboard-data-status.js";
import { playSound, SOUND_MANAGE_START } from "./dashboard-sounds.js";
import {
  applyPrivacyState,
  forceBothSubOptionsOn,
} from "./dashboard-privacy-subform.js";
import {
  paintManageUI,
  setManageInFlight,
  manageKey,
} from "./dashboard-manage-ui.js";

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
 * `app-config/app-defaults-for-user-configurable/ui-defaults.json`). Fetch failures
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

/** Build a symbol + (optional) address-with-copy fragment.
 *  Address text and copy icon are bound together in a flex row so the
 *  icon never wraps to its own left-aligned line when the address
 *  consumes most of the cell's width. */
function _tokenCellFrag(sym, addr) {
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(sym || "?"));
  if (addr) {
    const line = document.createElement("div");
    line.className = "9mm-pos-mgr-pool-detail-addr-line";
    line.appendChild(_addrWithCopyFrag(addr));
    frag.appendChild(line);
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
  el("pdBlockchain", botConfig.chainName || "—");
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
    log.info(
      "[lp-ranger] [reload] user requested reload for #%s",
      active.tokenId,
    );
    try {
      await fetchWithCsrf("/api/position/scan-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      log.warn("[lp-ranger] [reload] scan-cancel failed:", err.message);
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

/*- Single-flight is now per-position via `setManageInFlight(key, on)`
 *  in dashboard-manage-ui.js.  Click handlers stamp the key on entry
 *  and clear it in finally.  paintManageUI() consults the Map and
 *  returns null when the flag is set so the optimistic "Managing\u2026" /
 *  "Stopping\u2026" text survives across poll cycles.  Keying by
 *  walletAddress-contractAddress-tokenId prevents the prior page-scoped
 *  boolean's bug where switching positions mid-click mis-painted the
 *  destination position's button.  See dashboard-manage-ui.js. */

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
 * @param {object|string} payload  Server error body `{ error, message }`
 *   (preferred) OR a bare reason string (legacy callers / network
 *   errors that never reached the JSON parse).
 * @param {object} [active] Active position (for the spec line).
 */
function _handleManageFailure(verb, payload, active) {
  /*- Wrap the whole body in try/finally so the in-flight clear + paint
   *  ALWAYS fire \u2014 audit found that a misbehaving modal helper could
   *  leave the button stuck disabled if it threw before reaching the
   *  restore.  All other writes go through paintManageUI() instead of
   *  touching the DOM directly, so the single-owner invariant holds. */
  try {
    /*- Normalize the payload: accept legacy bare strings (network
     *  errors, HTTP-status-only fallbacks) and the new structured body
     *  emitted by `handleManage` (`{ error, message, tokenId }`). */
    const isObj = payload && typeof payload === "object";
    const code = isObj ? payload.error : payload;
    const message = isObj ? payload.message : payload;
    log.warn("[lp-ranger] [manage] %s failed: %s", verb, code || message);
    /*- `pool-info-unavailable` (503 from handleManage when getPoolState
     *  validation + retry was exhausted) is shown in a dedicated warning
     *  modal so the raw error message can be displayed in a scrollable
     *  code block.  Other failures keep the alert() path. */
    if (code === "pool-info-unavailable") {
      _showPoolInfoUnavailableModal(message, active);
      return;
    }
    const spec = _formatPositionSpec(active);
    const action = verb === "manage" ? "start managing" : "stop managing";
    const buttonLabel = verb === "manage" ? "Manage" : "Stop Managing";
    /*- The bot-loop-detect retry chain engages sticky RPC failover on
     *  every miss, so by the time the server returns "No V3 NFT position
     *  found" the next attempt is already routed through the backup. */
    const looksLikeRpcFailure = /No V3 NFT position found|RPC failure/i.test(
      code || "",
    );
    const retryHint = looksLikeRpcFailure
      ? `\n\nClick "${buttonLabel}" again to retry \u2014 the bot has already failed over to the backup RPC.`
      : `\n\nClick "${buttonLabel}" again to retry.`;
    /*- alert() is intentional here — the manage flow is a deliberate
     *  user action and silent failure is what got us into the stuck-UI
     *  state this branch is fixing. */
    alert(`Couldn't ${action}${spec ? " " + spec : ""}:\n${code}${retryHint}`);
  } finally {
    setManageInFlight(manageKey(active), false);
    paintManageUI();
  }
}

/*- Build + show the "Pool info unavailable" warning modal.  The raw
 *  server-side `err.message` is injected via `textContent` (NOT
 *  innerHTML) so a misbehaving RPC that returned markup-laden text
 *  cannot inject HTML into the page.  Modal body is otherwise a
 *  static string template — safe to pass to `_createModal`'s
 *  innerHTML-based body slot. */
function _showPoolInfoUnavailableModal(rawMessage, active) {
  const spec = _formatPositionSpec(active);
  const specHtml = spec
    ? '<p class="9mm-pos-mgr-text-muted">Position: ' + spec + "</p>"
    : "";
  const bodyHtml =
    "<p>Bringing this position under management failed.</p>" +
    specHtml +
    '<div class="9mm-pos-mgr-err-scroll" data-pool-info-err></div>' +
    '<p class="9mm-pos-mgr-text-muted">' +
    "See the LP Ranger console log in your Terminal for additional info, " +
    'then click "Manage" again to retry &mdash; each attempt issues fresh ' +
    "RPC calls with no cached state." +
    "</p>";
  _createModal(
    "9mm-pos-mgr-pool-info-unavailable-modal",
    "9mm-pos-mgr-warning-modal",
    "Pool info unavailable — cannot manage position",
    bodyHtml,
  );
  const slot = document.querySelector("[data-pool-info-err]");
  if (slot) slot.textContent = rawMessage || "(no detail returned)";
}

/** Send the DELETE request to stop managing `active`. */
async function _sendUnmanage(active) {
  const key = `pulsechain-${active.walletAddress}-${active.contractAddress}-${active.tokenId}`;
  // Suppress poll-driven auto-compound sync so it doesn't race back on
  suppressAutoCompoundSync(5000);
  const res = await fetchWithCsrf("/api/position/manage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    _handleManageFailure(
      "unmanage",
      body.error ? body : `HTTP ${res.status}`,
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
  const res = await fetchWithCsrf("/api/position/manage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenId: active.tokenId,
      contract: active.contractAddress,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    _handleManageFailure(
      "manage",
      body.error ? body : `HTTP ${res.status}`,
      active,
    );
    return false;
  }
  log.info("[lp-ranger] [manage] started managing #%s", active.tokenId);
  return true;
}

/*- Run the closed-position re-open dialog flow.  Per-position
 *  setManageInFlight(key, true) prevents a duplicate POST while the
 *  modal-based confirmation is open AND the bot loop spins up.
 *
 *  Synchronous optimistic disable mirrors the open-position click
 *  handler: paintManageUI() returns null while the in-flight flag is
 *  set (so the next poll cannot re-enable the button mid-flight), but
 *  on its own that leaves the button showing whatever state it had
 *  before the click — visibly still ENABLED until the request
 *  resolves.  The synchronous btn.disabled+title write below gives the
 *  user immediate feedback and blocks a fast second click that would
 *  otherwise queue another can-reopen POST + duplicate modal.
 *  Deliberately does NOT mutate the button TEXT — the modal that
 *  follows is the primary indicator; a "Checking…" label would just
 *  flicker into the next poll's rebalance-in-progress state. */
async function _runClosedPositionFlow(active) {
  /*- Sync-state race guard.  Defense-in-depth: the button should
   *  already be disabled when sync is incomplete (computeManageUI's
   *  syncComplete branch), but a click can still queue if the user
   *  catches the tail of an activation paint before the first poll
   *  lands.  Read the value from app state (single source of truth),
   *  NEVER from `syncBadge.classList` — see
   *  [[feedback-no-classlist-for-state]]. */
  const synced = isSyncComplete() === true;
  if (!synced) {
    log.info(
      "[lp-ranger] [reopen] Manage click ignored for #%s: app still syncing",
      active.tokenId,
    );
    return;
  }
  const key = manageKey(active);
  /*- Synchronous optimistic disable BEFORE setManageInFlight so the
   *  button stops accepting clicks the instant this handler runs.
   *  paintManageUI() will skip (manageInFlight=true → null spec), so
   *  this disable persists until the finally-block clears the flag and
   *  re-paints from server state. */
  const btn = g("manageToggleBtn");
  if (btn) {
    btn.disabled = true;
    btn.title = "Checking position for re-open…";
  }
  setManageInFlight(key, true);
  try {
    await runReopenFlow(active, {
      formatPositionSpec: _formatPositionSpec,
      handleManageFailure: _handleManageFailure,
    });
  } finally {
    setManageInFlight(key, false);
    paintManageUI();
  }
}

/** Toggle manage / pause for the active NFT position.  Single-flight
 *  is now per-position via setManageInFlight(); the synchronous
 *  optimistic disable below also blocks a within-tick second click
 *  on the same button. */
export async function _toggleManagePosition() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId || active.positionType !== "nft") return;
  const badge = g("manageBadge");
  const btn = g("manageToggleBtn");
  const isManaged = badge?.classList.contains("managed");
  const key = manageKey(active);
  /*- Closed-position re-open path: any drained NFT (liquidity=0)
   *  routes through `_runClosedPositionFlow` regardless of whether
   *  the SERVER currently has it in the managed set (it may, if a
   *  prior re-open started the bot loop but the rebalance aborted).
   *  The re-open flow always sends `forceRebalance: true`, and
   *  `handleManage` honors that on already-running positions via
   *  `_stampReopenFlagsOnLive`, so this is the correct path for
   *  both "fresh auto-retired" and "running-but-aborted" closed
   *  positions.  Without this branch the user would fall through
   *  to `_sendManage`, which silently no-ops on already-running. */
  if (isPositionClosed(active)) {
    await _runClosedPositionFlow(active);
    return;
  }
  /* Clear stale history so the next poll
     renders data for the correct position. */
  clearHistory();
  resetHistoryFlag();

  setManageInFlight(key, true);
  /*- Optimistic disable + label.  paintManageUI() observes the
   *  in-flight flag and returns null (skip apply), so this transient
   *  text survives across poll cycles until the click resolves. */
  if (btn) {
    btn.disabled = true;
    btn.textContent = isManaged ? "Stopping\u2026" : "Managing\u2026";
  }

  try {
    if (isManaged) {
      await _sendUnmanage(active);
    } else {
      /*- Populate the Range Width input SYNCHRONOUSLY from the
       *  active position's on-chain tick spread BEFORE the Manage
       *  POST fires, so the Bot Settings field is filled the instant
       *  the user commits to bringing the position under management
       *  — no wait on the next 3-second poll, no ever-empty state.
       *  No-op when the input is dirty, non-empty, or when ticks are
       *  missing (in which case `syncRangeWidth`'s per-poll retry
       *  covers it). */
      populateRangeWidthFromActive();
      await _sendManage(active);
    }
  } catch (err) {
    /*- Network error (fetch reject) — distinct from HTTP 4xx/5xx above. */
    _handleManageFailure(
      isManaged ? "unmanage" : "manage",
      err.message,
      active,
    );
  } finally {
    setManageInFlight(key, false);
    paintManageUI();
  }
}

/**
 * Per-poll badge + button update.  Kept as an exported function so the
 * existing caller in dashboard-data.js doesn't need a rename, but the
 * body now delegates to the single owner in dashboard-manage-ui.js —
 * all previous in-line state checks (closed gate, managed gate, in-
 * flight gate, rebalance-in-flight gate) are folded into the pure
 * compute function there.  Arguments are ignored; paintManageUI()
 * reads its own inputs from posStore + getLastStatus + DOM.
 */
export function updateManageBadge() {
  paintManageUI();
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
        id: "rebalanceIlWarningModal",
        close: closers.rebalanceIlWarning,
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
