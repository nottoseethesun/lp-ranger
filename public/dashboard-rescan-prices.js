/**
 * @file dashboard-rescan-prices.js
 * @description Re-scan Prices — the narrow counterpart to Reload
 * Current Position.
 *
 * Owns:
 *   - `openRescanPricesDialog()` — the explanation dialog and its
 *     guarded action button.
 *   - `paintRescanPricesButton()` — enable/disable + tooltip for the
 *     Settings item, called every poll alongside the Reload button's
 *     painter.
 *   - The `POST /api/position/rescan-prices` request.
 *
 * Why a separate control from Reload: every USD figure is
 * `amount x price`. Amounts come from chain and are reliable; prices
 * come from a feed cascade with no plausibility check, so one bad
 * response can be recorded permanently. Reload fixes that but re-walks
 * the pool's whole history. This clears only the price-derived figures
 * and re-values them at fresh prices.
 *
 * Managed-state gate: read from the published position state
 * (`posState.status`), never from the badge's CSS class — see
 * feedback-no-classlist-for-state.  `dashboard-manage-ui.js` derives
 * its own `isRunning` the same way.  Server-side the same field lives
 * on the DISK CONFIG, which `build-status-positions.js` merges into
 * this response; `server-rescan-prices.js` reads it from there.
 *
 * NOTE ON SHAPE: the object passed in is NOT the raw `/api/status`
 * body.  `dashboard-data-cache.js` flattens it to
 * `{ ...global, ...activePositionData, _allPositionStates, … }`, so
 * server `global.*` fields are read at the TOP level here — there is
 * no `.global` to reach through.
 *
 * Takes the polled `/api/status` payload as an argument rather than
 * importing `getLastStatus` from dashboard-data.js.  That import would
 * close an import cycle (dashboard-data -> … -> dashboard-events ->
 * this module -> dashboard-data); both callers already hold the
 * payload, so injecting it keeps this module dependency-free.
 *
 * External callers import from THIS module — no re-export shims
 * (per feedback-no-reexports).
 */

import { ethers } from "./ethers-adapter.js";
import { log } from "./dashboard-log.js";
import { g, cloneTpl, fetchWithCsrf } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";
/*- Safe to import: dashboard-config-inputs reaches only helpers,
 *  data-cache and throttle, none of which import this module — so unlike
 *  the dashboard-data import the header warns about, this closes no
 *  cycle. */
import { getInputDefault } from "./dashboard-config-inputs.js";

/*- Canonicalize to EIP-55 so the composite key byte-matches the
 *  server's (built via bot-config-v2.compositeKey, which checksums).
 *  Same guard as dashboard-reload-flow.js. */
function _toChecksum(addr) {
  if (!addr) return addr;
  try {
    return ethers.getAddress(addr);
  } catch {
    return addr;
  }
}

/** Composite key for the active position, or null. */
function _activeKey() {
  const a = posStore.getActive();
  if (!a?.tokenId) return null;
  const chain = "pulsechain";
  return [
    chain,
    _toChecksum(a.walletAddress),
    _toChecksum(a.contractAddress),
    a.tokenId,
  ].join("-");
}

/** Server-side state for a composite key, or null. */
function _positionState(status, key) {
  const all = status && status._allPositionStates;
  if (!all) return null;
  return all[key] || null;
}

/**
 * Is the active position managed?
 *
 * Reads the server's `status` field, which is the same value
 * `managedKeys()` filters on server-side and the route checks.
 *
 * @param {object} status  The latest /api/status payload.
 * @returns {boolean}
 */
function isActivePositionManaged(status) {
  const key = _activeKey();
  if (!key) return false;
  const st = _positionState(status, key);
  if (!st) return false;
  return st.status === "running";
}

/**
 * Enable/disable the Settings item.
 *
 * The button itself stays clickable whenever a position is selected —
 * the dialog is where the managed requirement is explained, so a user
 * who wonders why it is unavailable can read the reason rather than
 * meet a dead control. Only an in-flight move disables it outright,
 * matching `paintReloadPositionButton`.
 */
export function paintRescanPricesButton(status) {
  const btn = g("rescanPricesBtn");
  if (!btn) return;
  const key = _activeKey();
  const st = key ? _positionState(status, key) : null;
  const busy = !!st?.rebalanceInProgress || !!st?.compoundInProgress;
  btn.disabled = busy;
  btn.title = busy
    ? "Wait for the current move to finish before re-scanning prices."
    : "Re-value this position at freshly fetched prices. Use when a USD figure looks wrong.";
}

/*-
 *  Show the dialog's status line. It takes no space while hidden; see
 *  the `rescan-notice` rule in 9mm-pos-mgr.css for when it appears.
 *
 *  `text` omitted keeps the template's default copy.
 */
function _showNotice(el, text) {
  if (!el) return;
  if (text) el.textContent = text;
  el.classList.add("9mm-pos-mgr-is-shown");
}

function _hideNotice(el) {
  if (el) el.classList.remove("9mm-pos-mgr-is-shown");
}

/**
 * Bind the "last N days" option to the Per-Day rebuild it narrows.
 *
 * It only scopes that rebuild, so it follows that checkbox: enabled with
 * it, disabled and CLEARED without it. Clearing matters — a tick left
 * standing on a disabled control still reads as checked at submit time,
 * which would send a window for a rebuild that is not happening.
 *
 * The day count comes from the server's shipped defaults rather than a
 * literal here, so the label cannot disagree with the number the server
 * applies (feedback_one_literal_per_shipped_default). Until that fetch
 * resolves the label keeps its template wording, which names no number.
 *
 * @param {HTMLElement} overlay  The open dialog.
 */
function _wireRecentLimit(overlay) {
  const daily = overlay.querySelector("#rescanIncludeDailyPnl");
  const recent = overlay.querySelector("#rescanLimitRecent");
  if (daily === null || recent === null) return;
  const days = getInputDefault("rescanPricesRecentWindowDays");
  if (typeof days === "number" && days > 0) {
    const label = overlay.querySelector('[data-tpl="limitRecentLabel"]');
    if (label) label.textContent = `Limit to the last ${days} days`;
  }
  const sync = () => {
    recent.disabled = !daily.checked;
    if (!daily.checked) recent.checked = false;
  };
  daily.addEventListener("change", sync);
  sync();
}

/** Wire the dialog's controls once it is in the DOM. */
function _wireDialog(overlay, getStatus) {
  const status = getStatus();
  const managed = isActivePositionManaged(status);
  const go = overlay.querySelector("#rescanPricesGoBtn");
  const notice = overlay.querySelector('[data-tpl="notManaged"]');

  if (managed) _hideNotice(notice);
  else _showNotice(notice);

  _wireRecentLimit(overlay);

  if (go === null) return;
  go.disabled = !managed;
  go.addEventListener("click", () => _submit(overlay, go, getStatus));
}

/*- Poll cadence and cap both come from values the server already
 *  publishes on /api/status — no literals here.
 *
 *  `guaranteedDashboardHasPolledMs` is DASHBOARD_POLL_INTERVAL_MS x 2.5,
 *  i.e. "long enough that the dashboard has certainly re-polled". Using
 *  it as the interval means the very first check already reads a fresh
 *  snapshot, so a stale one carrying the PREVIOUS scan's
 *  `lifetimeScanComplete: true` can never be mistaken for this scan
 *  finishing. Polling faster would only re-read the same snapshot.
 *
 *  `rescanPricesTimeoutMs` caps the wait: past it, hand the button back rather
 *  than spin forever. */
function _cadence(status) {
  const every = Number(status?.guaranteedDashboardHasPolledMs);
  const cap = Number(status?.rescanPricesTimeoutMs);
  if (!Number.isFinite(every) || every <= 0) return null;
  return { every, cap: Number.isFinite(cap) && cap > 0 ? cap : null };
}

/*- Enter/leave the working state.
 *
 *  `data-busy` on the overlay is what stops Escape and the Close
 *  button from dismissing the dialog mid-scan — both handlers in
 *  dashboard-events-manage.js check it.  Close is disabled too, so the
 *  control looks unavailable rather than merely ignoring clicks. */
function _setBusy(overlay, go, busy) {
  const close = overlay.querySelector("[data-dismiss-modal]");
  if (busy) overlay.dataset.busy = "1";
  else delete overlay.dataset.busy;
  if (close) close.disabled = busy;
  go.classList.toggle("9mm-pos-mgr-is-working", busy);
  go.textContent = busy ? "Re-scanning…" : "Re-scan Prices";
  go.disabled = busy;
}

/** Return the button and dialog to their resting state. */
function _clearWorking(overlay, go) {
  _setBusy(overlay, go, false);
}

/*- Watch for the scan to finish, then close the dialog silently — no
 *  success banner, because the figures updating IS the result. Stops if
 *  the user closed the dialog first (overlay detached). If the server
 *  never published a cadence, skip auto-dismiss and hand the button
 *  back rather than inventing an interval. */
function _awaitCompletion(overlay, go, key, getStatus) {
  const timing = _cadence(getStatus());
  if (!timing) {
    log.warn("[rescan-prices] no poll cadence published; not auto-closing");
    _clearWorking(overlay, go);
    return;
  }
  const started = Date.now();
  const tick = () => {
    if (!overlay.isConnected) return;
    const st = _positionState(getStatus(), key);
    if (st && st.lifetimeScanComplete === true) {
      overlay.remove();
      log.info("[rescan-prices] complete for %s", key);
      return;
    }
    if (timing.cap && Date.now() - started > timing.cap) {
      _clearWorking(overlay, go);
      return;
    }
    setTimeout(tick, timing.every);
  };
  setTimeout(tick, timing.every);
}

/** POST the request and report the outcome in-dialog. */
async function _submit(overlay, go, getStatus) {
  const key = _activeKey();
  if (!key) return;
  _setBusy(overlay, go, true);
  /*-
   *  Read from the checkbox rather than kept in module state: the dialog
   *  is rebuilt from its template on every open, so the control starts
   *  unticked each time and the request cannot inherit a choice the
   *  operator made in an earlier one.
   */
  const includeDailyPnl =
    overlay.querySelector("#rescanIncludeDailyPnl")?.checked === true;
  /*- Sent as a flag, not a day count: the server owns the number, so a
   *  request cannot ask for a window the operator was never shown. Only
   *  meaningful with the rebuild above, and `_wireRecentLimit` clears it
   *  whenever that is unticked. */
  const limitToRecentDays =
    includeDailyPnl &&
    overlay.querySelector("#rescanLimitRecent")?.checked === true;
  const body = JSON.stringify({
    positionKey: key,
    includeDailyPnl,
    limitToRecentDays,
  });
  try {
    const res = await fetchWithCsrf("/api/position/rescan-prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      log.info("[rescan-prices] started for %s", key);
      _awaitCompletion(overlay, go, key, getStatus);
      return;
    }
    log.warn("[rescan-prices] rejected: %s", j.error || res.status);
    _clearWorking(overlay, go);
    const notice = overlay.querySelector('[data-tpl="notManaged"]');
    _showNotice(
      notice,
      j.message || "Could not start the price re-scan. Try again shortly.",
    );
  } catch (err) {
    log.warn("[rescan-prices] request failed: %s", err.message ?? err);
    _clearWorking(overlay, go);
  }
}

/**
 * Open the Re-scan Prices dialog.
 *
 * @param {Function} getStatus  Returns the latest /api/status payload.
 *   A getter rather than a snapshot because the dialog polls it to
 *   learn when the re-scan has finished.
 *
 * Body markup lives in the `tplRescanPricesModal` template in
 * index.html — no HTML is built here (per feedback-no-new-html-in-js).
 */
export function openRescanPricesDialog(getStatus) {
  const frag = cloneTpl("tplRescanPricesModal");
  if (!frag) return;
  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = "rescanPricesModal";
  overlay.appendChild(frag);
  document.body.appendChild(overlay);
  _wireDialog(overlay, getStatus);
}
