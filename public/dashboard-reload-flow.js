/**
 * @file dashboard-reload-flow.js
 * @description Reload Current Position — full escape-hatch flow.
 * Extracted from dashboard-events-manage.js so that file stays under
 * the 500-non-comment-line cap and this flow's cyclomatic budget
 * lives in its own module.
 *
 * Owns:
 *   - The blocking modal + spinner (`9mm-pos-mgr-blocking-overlay`).
 *   - The yellow "busy" modal used by every busy path (client-side
 *     pre-check, server 409, race detection).
 *   - The `POST /api/position/reload` request + 3s poll for
 *     completion / race / timeout.
 *   - `paintReloadPositionButton()` — the Mission-Control-aligned
 *     enable/disable + tooltip logic called every poll.
 *
 * External callers must import from THIS module — no re-export
 * shims elsewhere (per feedback-no-reexports).
 */

import { log } from "./dashboard-log.js";
import { ethers } from "./ethers-adapter.js";
import { g, fetchWithCsrf } from "./dashboard-helpers.js";
import { getLastStatus, resetHistoryFlag } from "./dashboard-data.js";
import { clearHistory } from "./dashboard-history.js";
import { resetLastFetchedId } from "./dashboard-unmanaged.js";
import { _createModal } from "./dashboard-data-status.js";

/*- Canonicalize an EVM address to EIP-55 checksum on entry.  Never
 *  let a lowercase (or otherwise non-canonical) address flow into a
 *  composite key, POST body, or lookup — server-side composite keys
 *  are always checksummed via `bot-config-v2.compositeKey()` +
 *  `ethers.getAddress()`, so a mismatch silently breaks every
 *  server-side lookup.  See [[feedback_eip55_checksum_url_segments]]
 *  and the same helper in `dashboard-router.js`. */
function _toChecksum(addr) {
  if (!addr) return addr;
  try {
    return ethers.getAddress(addr);
  } catch (err) {
    log.warn(
      "[lp-ranger] [reload] invalid EVM address: %s (%s)",
      addr,
      err.message,
    );
    return addr;
  }
}

/*- Injected reference to the position store (avoids circular dep with
 *  dashboard-positions.js).  Set by `injectPosStoreForReload` at
 *  bootstrap, mirroring the pattern in dashboard-events-manage.js. */
let _posStoreRef = null;

/** Inject posStore reference at bootstrap (avoids circular imports). */
export function injectPosStoreForReload(posStore) {
  _posStoreRef = posStore;
}

// ── Constants ───────────────────────────────────────

const _RELOAD_MODAL_ID = "reloadCurrentPositionModal";
/*- Client-side upper bound on how long we wait for the reload to
 *  complete before reloading the page anyway.  Matches the "up to
 *  four hours" ceiling in the modal copy. */
const _RELOAD_MAX_WAIT_MS = 4 * 60 * 60 * 1000;
const _RELOAD_POLL_MS = 3000;

// ── Small helpers ───────────────────────────────────

/*- Read the current sync state for `key` from the last-status payload.
 *  `getLastStatus()` returns the FLATTENED status object built by
 *  `flattenV2Status` in dashboard-data-cache.js — not the raw
 *  `/api/status` response.  The flattener exposes the per-position
 *  map on `_allPositionStates` (spread from the raw `positions` map);
 *  there is NO top-level `positions` on the flattened object.  Every
 *  other flattened-status consumer (e.g. `showPerPositionAlerts`)
 *  reads via `_allPositionStates` for exactly this reason. */
function _positionState(key) {
  const d = getLastStatus();
  const all = d && d._allPositionStates;
  if (!all) return null;
  return all[key] || null;
}

/*- Build the canonical composite key for a position.  Both EVM
 *  addresses are EIP-55 checksummed so the key byte-exactly matches
 *  the server-side composite key (built via `bot-config-v2.compositeKey`
 *  which also checksums).  Deliberately does NOT accept the raw
 *  posStore values — every caller must go through here. */
function _buildKey(walletAddress, contractAddress, tokenId) {
  return (
    "pulsechain-" +
    _toChecksum(walletAddress) +
    "-" +
    _toChecksum(contractAddress) +
    "-" +
    tokenId
  );
}

/** Build the composite key for the currently-active position. */
function _activeKey() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId) return null;
  return _buildKey(
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
}

// ── Modals ──────────────────────────────────────────

/** Build and insert the full-screen blocking modal.  Returns the overlay. */
function _showReloadBlockingModal(active, logPath) {
  const existing = document.getElementById(_RELOAD_MODAL_ID);
  if (existing) return existing;
  const overlay = document.createElement("div");
  overlay.id = _RELOAD_MODAL_ID;
  /*- Uses `9mm-pos-mgr-blocking-overlay` (not `modal-overlay`) so the
   *  global Escape-key handler in bindDelegatedEvents that pattern-
   *  matches `[class*="pos-mgr-modal-overlay"]` does NOT dismiss this
   *  shield.  The whole point is that the UI stays locked. */
  overlay.className = "9mm-pos-mgr-blocking-overlay";
  const inner = document.createElement("div");
  inner.className =
    "9mm-pos-mgr-modal 9mm-pos-mgr-modal-danger 9mm-pos-mgr-reload-modal";
  const title = document.createElement("h3");
  title.textContent = "Reloading position from the blockchain…";
  inner.appendChild(title);
  const p1 = document.createElement("p");
  p1.textContent =
    "Every on-chain-derived figure for NFT #" +
    (active.tokenId || "?") +
    " is being re-scanned from scratch. Do not close this tab.";
  inner.appendChild(p1);
  const p2 = document.createElement("p");
  p2.textContent =
    "This will take at least a few minutes and up to four hours, depending on how many rebalances the position has and how responsive the RPC endpoint is.";
  inner.appendChild(p2);
  const p3 = document.createElement("p");
  p3.className = "9mm-pos-mgr-text-muted";
  p3.textContent =
    "If a failure occurs, the full stacktrace is written to " +
    logPath +
    " on the machine running LP Ranger. When the scan finishes, the page will reload automatically.";
  inner.appendChild(p3);
  const spinner = document.createElement("div");
  spinner.className = "9mm-pos-mgr-reload-spinner";
  spinner.textContent = "Scanning…";
  inner.appendChild(spinner);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  return overlay;
}

const _RELOAD_BUSY_MODAL_ID = "reloadBusyModal";
const _RELOAD_BUSY_MSG_SLOT_ID = "reloadBusyModal-msg";

/*- Yellow (caution) "try again" modal.  One shell, three specific
 *  bodies (pre-check, race, server-message).  Removes any prior
 *  busy modal first so a rapid re-click cannot stack two copies with
 *  the same id.  The slot for the server-message variant is looked
 *  up below via `document.getElementById(_RELOAD_BUSY_MSG_SLOT_ID)`
 *  — an id (not a data attribute), so no cross-modal clashes. */
function _showReloadBusyModal(bodyHtml) {
  const existing = document.getElementById(_RELOAD_BUSY_MODAL_ID);
  if (existing) existing.remove();
  _createModal(
    _RELOAD_BUSY_MODAL_ID,
    "9mm-pos-mgr-modal-caution",
    "Try Reload Current Position again in a moment",
    bodyHtml +
      '<p class="9mm-pos-mgr-text-muted">Watch the Mission Control status badge to see when the position is idle again. Once it is, click <strong>Settings &rarr; Reload Current Position</strong> to try again.</p>',
  );
}

/** Race variant: auto-rebalance / auto-compound started in the 500ms window. */
function _showReloadRaceModal(active) {
  const label = active?.tokenId ? "NFT #" + active.tokenId : "the position";
  _showReloadBusyModal(
    "<p>An auto-rebalance or auto-compound started for " +
      label +
      " just before the Reload Current Position operation could begin. To keep the reload from racing that operation, LP Ranger dismissed the reload and left this position untouched.</p>",
  );
}

/** Server 409 variant: server's `message` is untrusted → textContent slot. */
function _showReloadServerBusyModal(serverMessage) {
  _showReloadBusyModal('<p id="' + _RELOAD_BUSY_MSG_SLOT_ID + '"></p>');
  const slot = document.getElementById(_RELOAD_BUSY_MSG_SLOT_ID);
  if (slot) slot.textContent = serverMessage;
}

// ── Poll for completion ─────────────────────────────

/*- Wait until either the target position reports lifetimeScanComplete,
 *  a fresh _catastrophicScanError lands, an auto-rebalance / auto-
 *  compound raced the reload, or the 4-hour ceiling elapses. */
function _waitForReloadCompletion(key, startedAtMs) {
  return new Promise((resolve) => {
    const started = startedAtMs;
    let tickCount = 0;
    const tick = () => {
      tickCount++;
      const elapsed = Date.now() - started;
      if (elapsed >= _RELOAD_MAX_WAIT_MS) return resolve("timeout");
      const st = _positionState(key);
      /*- Per-tick log so a failed poll-detection is visible within
       *  3 seconds of the modal opening — no need to sit through the
       *  full scan to know whether the polling machinery works. */
      log.info(
        "[lp-ranger] [reload] tick #%d elapsed=%ds stFound=%s lifetimeScanComplete=%s rebIP=%s compIP=%s catastrophic=%s key=%s",
        tickCount,
        Math.floor(elapsed / 1000),
        !!st,
        st?.lifetimeScanComplete,
        !!st?.rebalanceInProgress,
        !!st?.compoundInProgress,
        !!st?._catastrophicScanError,
        key,
      );
      if (!st) return setTimeout(tick, _RELOAD_POLL_MS);
      if (st.rebalanceInProgress || st.compoundInProgress)
        return resolve("raced");
      if (st._catastrophicScanError && st._catastrophicScanError.at > started)
        return resolve("failed-again");
      if (st.lifetimeScanComplete === true) return resolve("complete");
      setTimeout(tick, _RELOAD_POLL_MS);
    };
    setTimeout(tick, _RELOAD_POLL_MS);
  });
}

// ── Reload flow — split into pieces to keep complexity ≤ 17 ─────

/*- Confirm text carries the four-hour warning on its own line so the
 *  user has to read past it before clicking OK. */
function _buildConfirmMessage(tokenId) {
  return (
    "Reload Current Position for NFT #" +
    (tokenId || "?") +
    "?\n\n" +
    "THIS CAN TAKE UP TO FOUR HOURS.\n\n" +
    "During that time the entire LP Ranger dashboard is disabled and " +
    "you cannot use it for anything else. If four hours is too long to " +
    "wait right now, click Cancel and run this later.\n\n" +
    "What it does: wipes every on-chain-derived figure for this " +
    "position (compound history, HODL baseline, deposits, cached " +
    "epochs, cached event log) and re-scans from scratch. When the " +
    "scan finishes, the page reloads automatically.\n\n" +
    "Click OK to proceed, or Cancel to leave the position as-is."
  );
}

/*- Defense-in-depth: the button is disabled by paintReloadPositionButton
 *  while a rebalance or compound is in flight, but a click can still
 *  land between poll cycles.  Re-read the flags and surface the yellow
 *  modal on hit.  Returns true when a pre-check tripped so the caller
 *  can early-return. */
function _preCheckBusy(preSt) {
  if (preSt?.rebalanceInProgress) {
    _showReloadBusyModal(
      "<p>This position is currently rebalancing. LP Ranger cannot start a Reload Current Position while a rebalance is in flight — the reload would race the transaction and either corrupt the state reconstruction or step on the tracker mid-write.</p>",
    );
    return true;
  }
  if (preSt?.compoundInProgress) {
    _showReloadBusyModal(
      "<p>This position is currently compounding. LP Ranger cannot start a Reload Current Position while a compound is in flight — the reload would race the transaction and either corrupt the state reconstruction or step on the tracker mid-write.</p>",
    );
    return true;
  }
  return false;
}

/*- POST /api/position/reload.  Returns { ok: true } on success, or
 *  { ok: false, status, body } on any non-2xx, or throws for network
 *  failures. */
async function _postReload(key) {
  const res = await fetchWithCsrf("/api/position/reload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionKey: key }),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, body };
}

/*- Handle a non-2xx server response.  409 → yellow busy modal, other
 *  errors → alert().  Always dismisses the overlay and re-enables the
 *  button. */
function _handleServerError(status, body, overlay, btn) {
  log.warn(
    "[lp-ranger] [reload] server rejected reload: %s",
    body.error || status,
  );
  overlay.remove();
  if (btn) btn.disabled = false;
  if (status === 409 && body.message) {
    _showReloadServerBusyModal(body.message);
    return;
  }
  const userMessage = body.message || body.error || `HTTP ${status}`;
  alert("Reload Current Position failed: " + userMessage);
}

/*- Terminal outcome dispatch.  Race → dismiss + yellow modal; every
 *  other outcome falls through to a page reload. */
function _finishReload(outcome, active, overlay, btn) {
  log.info("[lp-ranger] [reload] outcome=%s", outcome);
  if (outcome === "raced") {
    overlay.remove();
    if (btn) btn.disabled = false;
    _showReloadRaceModal(active);
    return;
  }
  window.location.reload();
}

// ── Exported: click handler ─────────────────────────

/**
 * Wipe every on-chain-derived figure for the active position and
 * re-scan from scratch.  A full-viewport blocking modal disables the
 * UI while the server-side reload runs; when the scan completes the
 * page is reloaded so all client-side caches are dropped and the
 * fresh figures render on a clean surface.
 *
 * Every step lives in its own helper so the top-level function stays
 * inside the cyclomatic-complexity cap.  See docs/engineering.md §
 * Error Log & Reload Current Position for the full flow.
 */
export async function _reloadCurrentPosition() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId) return;
  const key = _buildKey(
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  if (_preCheckBusy(_positionState(key))) return;
  if (!confirm(_buildConfirmMessage(active.tokenId))) return;
  const btn = g("reloadPositionBtn");
  if (btn) btn.disabled = true;
  const overlay = _showReloadBlockingModal(active, "logs/error.log");
  const startedAt = Date.now();
  log.info(
    "[lp-ranger] [reload] user requested full reload for #%s",
    active.tokenId,
  );
  let resp;
  try {
    resp = await _postReload(key);
  } catch (err) {
    log.warn("[lp-ranger] [reload] request failed: %s", err.message);
    overlay.remove();
    if (btn) btn.disabled = false;
    alert(
      "Reload Current Position failed to reach the server: " +
        err.message +
        "\n\nCheck that the LP Ranger server is running.",
    );
    return;
  }
  if (!resp.ok) return _handleServerError(resp.status, resp.body, overlay, btn);
  resetHistoryFlag();
  clearHistory();
  resetLastFetchedId();
  const outcome = await _waitForReloadCompletion(key, startedAt);
  _finishReload(outcome, active, overlay, btn);
}

// ── Exported: per-poll button paint ─────────────────

/**
 * Paint the Reload Current Position button — disabled with a tooltip
 * while the active position is mid-rebalance or mid-compound.  Called
 * from the poll cycle so the button flips back to enabled the moment
 * the operation finishes.  Uses the same `rebalanceInProgress` /
 * `compoundInProgress` flags that drive the Mission Control status
 * badge, so the two surfaces always agree.  Deliberately NOT gated
 * on `_scanRunning` — a normal startup or post-rebalance scan should
 * not permanently disable the escape hatch.
 */
export function paintReloadPositionButton() {
  const btn = g("reloadPositionBtn");
  if (!btn) return;
  const key = _activeKey();
  const st = key ? _positionState(key) : null;
  const rebalancing = !!st?.rebalanceInProgress;
  const compounding = !!st?.compoundInProgress;
  if (rebalancing || compounding) {
    btn.disabled = true;
    btn.title = rebalancing
      ? "Wait for the current rebalance to finish before reloading this position."
      : "Wait for the current compound to finish before reloading this position.";
    return;
  }
  btn.disabled = false;
  btn.title =
    "Wipe every on-chain-derived figure for the current position and re-scan from scratch. Takes a few minutes to four hours.";
}
