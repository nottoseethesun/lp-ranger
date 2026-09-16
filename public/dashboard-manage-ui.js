/**
 * @file dashboard-manage-ui.js
 * @description Single owner of Manage button + badge + Lifetime panel +
 *   Pool-details button UI. Every write to those elements goes through
 *   here; `dashboard-manage-badge.js`, `dashboard-events-manage.js` and
 *   `dashboard-data.js` all call `paintManageUI()` rather than touching
 *   the DOM themselves, so the rendered state cannot depend on which
 *   trigger fired last.
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
/*- The SAME pair-normalisation the server decides with, not a copy of
 *  it.  src/pool-key.js is deliberately dependency-free so esbuild can
 *  bundle it into this browser build; src/position-manager.js, which
 *  builds the scoped key on top, cannot cross that line. */
import { poolKey } from "../src/pool-key.js";

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

/*- Per-position click-in-flight Map, keyed by
 *  walletAddress-contractAddress-tokenId.  A single page-scoped boolean
 *  cannot serve: click Manage on A, switch to B, and B's button paints
 *  A's "Managing…" optimistic label. */
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
    poolManagedBy,
    reopenSupersededBy,
    poolHasOpen,
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

  const blocked = _refusalTitle({
    isRunning,
    isClosed,
    poolManagedBy,
    poolHasOpen,
    reopenSupersededBy,
  });
  if (blocked !== null) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: blocked,
      ..._common,
    };
  }

  if (isClosed) return _computeClosedSynced(posState, nowMs, retireDebounceMs);
  return _computeOpenSynced(posState, isRunning, _currentText);
}

/**
 * Why the Manage button must be refused, or null when it need not be.
 *
 * Three rules, all serving one invariant: a pool holds at most one
 * funded position, so that profit and loss stays attributable to it.
 * They are checked strongest-first.
 *
 *  1. The pool already has a MANAGED position. The server refuses this
 *     outright (409 `pool-already-managed`), so offering the button
 *     would only produce an error after the click. Skipped when this
 *     IS the running position — it must keep its "Stop Managing".
 *  2. The pool already has an OPEN position. Re-opening a closed one
 *     beside it would fund the pool twice. Stronger than rule 3: it
 *     does not matter whether this is the newest closed NFT, because
 *     nothing was lost and so nothing needs recovering.
 *  3. This is not the NEWEST closed position in the pool. Re-opening
 *     recovers a position a rebalance drained and failed to replace,
 *     which is always the newest one; an older drained NFT is settled
 *     history the app has already accounted for.
 *
 * Extracted from `computeManageUI` to keep that function under the
 * complexity cap, and because the three read as one policy.
 *
 * @param {object} o
 * @returns {string|null}  Tooltip text, or null to allow.
 */
function _refusalTitle(o) {
  if (!o.isRunning && o.poolManagedBy) {
    return (
      "This liquidity pool is already managed by position #" +
      o.poolManagedBy +
      ". LP Ranger manages one position per pool, so that profit and " +
      "loss stays attributable. Stop that position first if you want " +
      "to manage this one instead."
    );
  }
  if (!o.isClosed) return null;
  if (o.poolHasOpen) {
    return (
      "This liquidity pool already has an open position, #" +
      o.poolHasOpen +
      ". Re-opening this closed one would leave two positions in the " +
      "same pool, which makes profit and loss impossible to attribute " +
      "to either. Manage #" +
      o.poolHasOpen +
      " instead, or close it first."
    );
  }
  if (o.reopenSupersededBy) {
    return (
      "Only the newest closed position in a pool can be re-opened, " +
      "and this is not it — position #" +
      o.reopenSupersededBy +
      " in the same pool is newer. Re-opening recovers a position a " +
      "rebalance drained and did not replace, which is always the " +
      "newest one. You can still select this position to view its " +
      "history."
    );
  }
  return null;
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
/*- Which running position, if any, already holds the active position's
 *  pool — advisory only.
 *
 *  The server is the authority: `rejectIfPoolManaged` in
 *  src/pool-already-managed.js refuses the request regardless of what
 *  this returns, using the canonical key from `src/pool-key.js`.
 *  That rule cannot be imported here (CommonJS), and the position being
 *  managed is unmanaged, so the server has not attached a pool key for
 *  it. The comparison is therefore repeated on the raw triple.
 *
 *  Drift is tolerable precisely because this is advisory: if the two
 *  ever disagree, the button is offered and the server refuses the
 *  click — the behaviour before this gate existed — rather than
 *  anything being managed that should not be. */
/**
 * Fully-qualified canonical pool key for a posStore entry, or null.
 *
 * Built with `poolKey` from `src/pool-key.js` — the same function the
 * server decides with — so the two tiers cannot disagree about what
 * counts as one pool. Qualified by chain, position-manager contract and
 * wallet as well as the pair and fee, matching what `attachPoolKeys`
 * publishes on `GET /api/status`.
 *
 * The chain defaults to "pulsechain" exactly as `compositeKey` in
 * dashboard-helpers.js does; entries do not carry one. On a chain whose
 * name differs, keys built here stop matching the server's and every
 * gate below simply goes quiet — the button is offered and the server
 * refuses it, which is the safe direction for an advisory check.
 *
 * Null for an incomplete identity rather than a partial key:
 * `poolKey` stringifies whatever it is given, so an entry missing its
 * wallet would yield "…-undefined-…" and two such entries would compare
 * equal.
 *
 * @param {object|null|undefined} e  posStore entry.
 * @returns {string|null}
 */
export function _poolKeyOf(e) {
  if (e === undefined || e === null) return null;
  const parts = [e.walletAddress, e.contractAddress, e.token0, e.token1];
  for (const v of parts) {
    if (typeof v !== "string" || v.length === 0) return null;
  }
  if (e.fee === undefined || e.fee === null || e.fee === "") return null;
  return poolKey(
    e.blockchain || "pulsechain",
    e.contractAddress,
    e.walletAddress,
    e.token0,
    e.token1,
    e.fee,
  );
}

export function _poolHeldBy(active, allStates) {
  const want = _poolKeyOf(active);
  if (want === null) return null;
  for (const st of Object.values(allStates || {})) {
    if (!st || st.running !== true) continue;
    /*- The server attaches this in `attachPoolKeys`, built by the same
     *  `poolKey`. Read it rather than rebuilding from activePosition,
     *  which carries no wallet or contract of its own. */
    if (st.poolKey !== want) continue;
    const ap = st.activePosition;
    if (!ap || String(ap.tokenId) === String(active.tokenId)) continue;
    return String(ap.tokenId);
  }
  return null;
}

/*- Same-pool test for two entries, via the one canonical key above.
 *  Two entries whose identity cannot be resolved are NOT the same pool
 *  — null must not match null. */
function _samePool(a, b) {
  const k = _poolKeyOf(a);
  return k !== null && k === _poolKeyOf(b);
}

/**
 * The newest closed position in `active`'s pool, when it is not
 * `active` itself.
 *
 * Returns a tokenId string when some OTHER closed position in the same
 * pool is newer, meaning `active` must not be re-opened; null when
 * `active` is the newest closed one, is not closed, or the comparison
 * cannot be made.
 *
 * Compared as BigInt, not as text: NFT ids grow with mint order, so
 * numeric order IS recency, but "#99" sorts after "#100" as a string
 * and the newest would be mistaken for an old one.
 *
 * @param {object|null} active   posStore entry.
 * @param {object[]} entries     All posStore entries.
 * @returns {string|null}
 */
/**
 * An open position in `active`'s pool, other than `active` itself.
 *
 * Re-opening a closed position while the pool already holds an open one
 * would leave two funded positions in that pool — the situation the
 * one-position-per-pool rule exists to prevent, arrived at from the
 * other direction. The pool gate catches it only when the open position
 * is being *managed*; an open position sitting unmanaged in the wallet
 * is invisible to it, and this is what covers that case.
 *
 * Liquidity is tested explicitly rather than through
 * `isPositionClosed`, which reports a position with no liquidity field
 * as not-closed. Here that would read as "open" and block a legitimate
 * re-open on missing data. The question this asks is "is it definitely
 * open", which is not the negation of "is it closed": unknown counts as
 * neither.
 *
 * @param {object|null} active   posStore entry.
 * @param {object[]} entries     All posStore entries.
 * @returns {string|null}  Token id of an open sibling, or null.
 */
export function _openInPool(active, entries) {
  if (!active || !Array.isArray(entries)) return null;
  for (const e of entries) {
    if (!e || !_samePool(active, e)) continue;
    if (String(e.tokenId) === String(active.tokenId)) continue;
    if (e.liquidity === undefined || e.liquidity === null) continue;
    if (String(e.liquidity) === "0") continue;
    return String(e.tokenId);
  }
  return null;
}

/*- Token id as BigInt, or null when it is absent or not a number. */
function _asBigInt(v) {
  if (v === null || v === undefined) return null;
  /*- BigInt("") is 0n rather than a throw, so an empty id would read as
   *  token 0 — below every real id, which silently turns "is anything
   *  newer than me" into "everything is". */
  if (typeof v === "string" && v.trim().length === 0) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export function _newerClosedInPool(active, entries) {
  const mine = active ? _asBigInt(active.tokenId) : null;
  if (mine === null || !Array.isArray(entries)) return null;
  let newest = null;
  for (const e of entries) {
    /*- Order matters: the pool and id tests are cheap and silent,
     *  while `isPositionClosed` warns to the console for an entry with
     *  no liquidity field.  Running it over the whole store on every
     *  three-second paint would fill the log.  By here the candidates
     *  are the same pool AND newer, which is a handful at most. */
    if (!e || !_samePool(active, e)) continue;
    const id = _asBigInt(e.tokenId);
    if (id === null || id <= mine) continue;
    if (!isPositionClosed(e)) continue;
    if (newest === null || id > newest) newest = id;
  }
  return newest === null ? null : String(newest);
}

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
  const isClosedActive = !!active && isPositionClosed(active);
  applyManageUI(
    computeManageUI({
      hasActive: !!active,
      isClosed: isClosedActive,
      isNft: !!active && active.positionType === "nft",
      posState: status,
      syncComplete,
      walletUnlocked,
      manageInFlight,
      poolManagedBy: _poolHeldBy(active, status?._allPositionStates),
      poolHasOpen: isClosedActive
        ? _openInPool(active, _posStoreRef?.entries)
        : null,
      reopenSupersededBy: isClosedActive
        ? _newerClosedInPool(active, _posStoreRef?.entries)
        : null,
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
