/**
 * @file dashboard-manage-ui.js
 * @description Single owner of Manage button + badge + Lifetime panel +
 *   Pool-details button UI. Replaces the nine competing writers that
 *   used to scatter across dashboard-manage-badge.js,
 *   dashboard-events-manage.js, dashboard-data.js, and
 *   dashboard-throttle-rebalance.js.
 *
 * Architecture:
 *   - `computeManageUI(inputs)` — pure: state -> UISpec (or null to skip)
 *   - `applyManageUI(spec)`     — DOM writer with no decision logic
 *   - `paintManageUI()`         — gather inputs + apply; every trigger calls it
 *   - `setManageInFlight(key, on)` — per-position click-in-flight Map
 *
 * Post-retire debounce uses the server-stamped `lastRetiredAt`
 * (epoch ms) field that flows through `/api/status`. This is
 * stateless and survives position switches and dropped polls — the
 * prior client-side Map was broken for both scenarios.
 */

import { g } from "./dashboard-helpers.js";
import { isPositionClosed } from "./dashboard-positions-store.js";
import { isWalletUnlocked } from "./dashboard-wallet.js";

export const MANAGE_SYNCING_HELP =
  'This button will be clickable once the "Syncing…" badge above is finished.';

const _MANAGE_REOPEN_HELP =
  "Re-open this closed position (requires a rebalance to seed liquidity from your wallet).";
const _MANAGE_STOP_HELP =
  "Remove this position from active management by LP Ranger.";
const _MANAGE_START_HELP =
  "Bring this position under active management by LP Ranger.";
const _MANAGE_REBALANCING_HELP =
  "Re-open in progress — bot is submitting the rebalance. Wait for completion.";
const _MANAGE_RECOVERY_HELP =
  "Re-open recovering — bot is retrying mint from wallet balances. Wait for completion.";
const _MANAGE_PAUSED_HELP =
  "Re-open just failed — the bot will auto-retire shortly. Watch for the alert above.";
const _MANAGE_DEBOUNCE_HELP =
  "Re-open just retired — wait a moment so the alert above can render.";
const _MANAGE_LOCKED_HELP = "Unlock wallet to manage positions";
const _MANAGE_ERC20_HELP = "Only NFT (V3) positions can be managed";
const _MANAGE_LOADING_HELP = "Loading position state…";
const _MANAGE_REBALANCE_OPEN_HELP =
  "Rebalance in progress — wait for completion before clicking again.";
const _NO_ACTIVE_HELP = "Select a position first";
const _PD_VIEW_HELP = "View pool and contract details";

/*- Per-position click-in-flight Map.  Replaces the old module-private
 *  boolean in dashboard-events-manage.js — that one was page-scoped, so
 *  if a user clicked Manage on A then switched to B, B's button
 *  briefly painted A's "Managing…" optimistic label.  Keying by
 *  walletAddress-contractAddress-tokenId scopes the flag to the
 *  originating position. */
const _manageInFlight = new Map();

/** Build the in-flight Map key for an active position.  Exported so
 *  click handlers in other modules use the SAME key shape as the
 *  paint-time consumer. */
export function manageKey(active) {
  if (!active) return null;
  return [active.walletAddress, active.contractAddress, active.tokenId]
    .filter(Boolean)
    .join("-");
}

/**
 * Mark a position as click-in-flight (`on=true`) or clear it
 * (`on=false`).  Click handler calls this before fetch and again in
 * `finally` so the optimistic UI window is bounded.
 */
export function setManageInFlight(positionKey, on) {
  if (!positionKey) return;
  if (on) _manageInFlight.set(positionKey, true);
  else _manageInFlight.delete(positionKey);
}

let _posStoreRef = null;
let _getLastStatusRef = null;
let _isSyncCompleteRef = null;

/**
 * Inject dependencies once at init time so the new module can stay
 * import-cycle-free relative to dashboard-data.js and dashboard-positions.js.
 * @param {object} deps
 * @param {object} deps.posStore        Must expose getActive().
 * @param {Function} deps.getLastStatus Returns last polled /api/status payload.
 * @param {Function} deps.isSyncComplete Returns true|false|null for whether
 *   the active position is fully synced.  Replaces a previous direct read of
 *   `syncBadge.classList.contains("done")` — see
 *   [[feedback-no-classlist-for-state]].
 */
export function injectManageUIDeps(deps) {
  _posStoreRef = deps.posStore || null;
  _getLastStatusRef = deps.getLastStatus || null;
  _isSyncCompleteRef = deps.isSyncComplete || null;
}

/* ──────────────────── pure compute ──────────────────── */

/**
 * Pure decision tree.  Returns a UISpec describing how the button,
 * badge, Lifetime panel, and pool-details button should render, OR
 * `null` to mean "skip apply" (used when the click handler owns the
 * optimistic "Managing…" / "Stopping…" label transiently).
 *
 * Fully pure — all inputs are primitives or plain objects; no DOM
 * access, no module-level state reads, no external function calls.
 * `paintManageUI()` is the caller that gathers the inputs from
 * posStore + getLastStatus + DOM; this function just decides.
 *
 * @typedef {object} UISpec
 * @property {string}  buttonText
 * @property {boolean} buttonDisabled
 * @property {string}  buttonTitle
 * @property {string}  badgeText
 * @property {boolean} badgeManaged      Apply the green pulsing-dot.
 * @property {boolean} lifetimeVisible
 * @property {boolean} pdBtnDisabled
 * @property {string}  pdBtnTitle
 *
 * @param {object} inputs
 * @param {boolean}     inputs.hasActive        True when posStore has a
 *   selected position.  When false, the rest of the inputs are ignored.
 * @param {boolean}     inputs.isClosed         Active position has liquidity=0.
 * @param {boolean}     inputs.isNft            Active position is an NFT (V3).
 * @param {object|null} inputs.posState         Per-position /api/status slice;
 *   null when no poll has landed yet for this position.
 * @param {boolean}     inputs.syncComplete     Sync-done DOM class state.
 * @param {boolean}     inputs.walletUnlocked
 * @param {boolean}     inputs.manageInFlight   Click in flight for active.
 * @param {number}      inputs.nowMs            Date.now() — injected for tests.
 * @param {number}      inputs.retireDebounceMs Post-retire debounce window;
 *   reads `guaranteedDashboardHasPolledMs` from /api/status (which is
 *   DASHBOARD_POLL_INTERVAL_MS * 2.5 in src/config.js — single source
 *   of truth).  When 0 or unset, the debounce branch never fires.
 * @returns {UISpec|null}
 */
export function computeManageUI(inputs) {
  const {
    hasActive,
    isClosed,
    isNft,
    posState,
    syncComplete,
    walletUnlocked,
    manageInFlight,
    nowMs,
    retireDebounceMs,
  } = inputs;

  if (!hasActive) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _NO_ACTIVE_HELP,
      badgeText: "Not Actively Managed",
      badgeManaged: false,
      lifetimeVisible: false,
      pdBtnDisabled: true,
      pdBtnTitle: _NO_ACTIVE_HELP,
    };
  }

  if (manageInFlight) return null;

  if (!posState) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _MANAGE_LOADING_HELP,
      badgeText: isClosed ? "Position Closed" : "Not Actively Managed",
      badgeManaged: false,
      lifetimeVisible: false,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }

  const isRunning = posState.status === "running" && !isClosed;
  const badgeText = _deriveBadgeText(isClosed, isRunning);
  const _currentText = isRunning ? "Stop Managing" : "Manage";
  const _common = {
    badgeText,
    badgeManaged: isRunning,
    lifetimeVisible: isRunning,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };

  if (!walletUnlocked) {
    return {
      buttonText: isClosed ? "Manage" : _currentText,
      buttonDisabled: true,
      buttonTitle: _MANAGE_LOCKED_HELP,
      ..._common,
    };
  }

  if (!isNft) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _MANAGE_ERC20_HELP,
      ..._common,
    };
  }

  if (!syncComplete) {
    return {
      buttonText: isClosed ? "Manage" : _currentText,
      buttonDisabled: true,
      buttonTitle: MANAGE_SYNCING_HELP,
      ..._common,
    };
  }

  if (isClosed) return _computeClosedSynced(posState, nowMs, retireDebounceMs);
  return _computeOpenSynced(posState, isRunning, _currentText);
}

function _deriveBadgeText(isClosed, isRunning) {
  if (isClosed) return "Position Closed";
  if (isRunning) return "Being Actively Managed";
  return "Not Actively Managed";
}

/** Closed + synced sub-tree.  Decision order matters — see the
 *  "Branch-precedence audit" in the plan file. */
function _computeClosedSynced(posState, nowMs, retireDebounceMs) {
  let disabled = false;
  let title = _MANAGE_REOPEN_HELP;
  if (posState.rebalanceInProgress || posState.forceRebalance) {
    disabled = true;
    title = _MANAGE_REBALANCING_HELP;
  } else if (posState.rebalanceFailedMidway) {
    disabled = true;
    title = _MANAGE_RECOVERY_HELP;
  } else if (posState.rebalancePaused) {
    disabled = true;
    title = _MANAGE_PAUSED_HELP;
  } else if (
    posState.lastRetiredAt &&
    retireDebounceMs &&
    nowMs - posState.lastRetiredAt < retireDebounceMs
  ) {
    disabled = true;
    title = _MANAGE_DEBOUNCE_HELP;
  }
  return {
    buttonText: "Manage",
    buttonDisabled: disabled,
    buttonTitle: title,
    badgeText: "Position Closed",
    badgeManaged: false,
    lifetimeVisible: false,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };
}

/** Open + synced sub-tree. */
function _computeOpenSynced(posState, isRunning, currentText) {
  if (posState.rebalanceInProgress) {
    return {
      buttonText: currentText,
      buttonDisabled: true,
      buttonTitle: _MANAGE_REBALANCE_OPEN_HELP,
      badgeText: _deriveBadgeText(false, isRunning),
      badgeManaged: isRunning,
      lifetimeVisible: isRunning,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }
  if (isRunning) {
    return {
      buttonText: "Stop Managing",
      buttonDisabled: false,
      buttonTitle: _MANAGE_STOP_HELP,
      badgeText: "Being Actively Managed",
      badgeManaged: true,
      lifetimeVisible: true,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }
  return {
    buttonText: "Manage",
    buttonDisabled: false,
    buttonTitle: _MANAGE_START_HELP,
    badgeText: "Not Actively Managed",
    badgeManaged: false,
    lifetimeVisible: false,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };
}

/* ──────────────────── DOM applier ──────────────────── */

/** Apply a UISpec to the DOM.  No decisions, just writes. */
export function applyManageUI(spec) {
  if (spec === null) return;
  _paintBadge(spec);
  const btn = g("manageToggleBtn");
  if (btn) {
    btn.textContent = spec.buttonText;
    btn.disabled = spec.buttonDisabled;
    btn.title = spec.buttonTitle;
  }
  const pdBtn = g("poolDetailsBtn");
  if (pdBtn) {
    pdBtn.disabled = spec.pdBtnDisabled;
    pdBtn.title = spec.pdBtnTitle;
  }
  const content = g("ltContent");
  const placeholder = g("ltUnmanagedPlaceholder");
  if (content)
    content.classList.toggle("9mm-pos-mgr-lt-hidden", !spec.lifetimeVisible);
  if (placeholder) placeholder.hidden = spec.lifetimeVisible;
}

function _paintBadge(spec) {
  const badge = g("manageBadge");
  if (!badge) return;
  badge.classList.toggle("managed", spec.badgeManaged);
  if (spec.badgeManaged) {
    const dot = document.createElement("span");
    dot.className = "9mm-pos-mgr-manage-dot";
    badge.replaceChildren(dot, document.createTextNode(spec.badgeText));
  } else {
    badge.textContent = spec.badgeText;
  }
}

/* ──────────────────── gather + paint convenience ──────────────────── */

/** Single entry point — every trigger calls this. */
export function paintManageUI() {
  const active = _posStoreRef?.getActive?.() || null;
  const status = _getLastStatusRef ? _getLastStatusRef() : null;
  /*- Read sync completeness from app state (the source-of-truth value
   *  that `_updateSyncBadge` also uses to set the badge class), NEVER
   *  from `syncBadge.classList`.  See
   *  [[feedback-no-classlist-for-state]].  A null from `isSyncComplete`
   *  means no poll has landed yet — coerce to false so the gate is
   *  conservative during the boot window. */
  const syncComplete = _isSyncCompleteRef
    ? _isSyncCompleteRef() === true
    : false;
  const walletUnlocked = isWalletUnlocked();
  const manageInFlight = _manageInFlight.has(manageKey(active));
  applyManageUI(
    computeManageUI({
      hasActive: !!active,
      isClosed: !!active && isPositionClosed(active),
      isNft: !!active && active.positionType === "nft",
      posState: status,
      syncComplete,
      walletUnlocked,
      manageInFlight,
      nowMs: Date.now(),
      /*- Server's GUARANTEED_DASHBOARD_HAS_POLLED_MS (=
       *  DASHBOARD_POLL_INTERVAL_MS * 2.5 in src/config.js) flows
       *  through /api/status's global block as
       *  guaranteedDashboardHasPolledMs.  When the first poll hasn't
       *  landed (status is null), the closed+synced branch can't run
       *  anyway — the posState=null branch fires first. */
      retireDebounceMs: status?.guaranteedDashboardHasPolledMs || 0,
    }),
  );
}
