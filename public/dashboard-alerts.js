/**
 * @file dashboard-alerts.js
 * @description Per-position alert/modal dispatch. Walks
 * `_allPositionStates` every poll and surfaces rebalance-paused errors,
 * OOR recovery confirmations, and post-rebalance warnings — each
 * labeled with the ORIGINATING position's identity (derived from the
 * server event's composite key + per-position state), not the
 * currently-viewed tab. Dedup is keyed per composite key so concurrent
 * failures on different positions each get their own modal, and a
 * future re-pause of the same position re-fires after the first clears.
 */
import { cloneTpl, botConfig } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import { _createModal } from "./dashboard-data-status.js";
import { showPostRebalanceWarnings } from "./dashboard-post-rebalance-modal.js";

/*- Dedup Sets keyed by composite key. Cleared only when the server
 *  condition for that key clears — that way dismiss+re-pause still
 *  re-surfaces, but every poll doesn't re-spam the same modal. */
const _errShown = new Set();
const _recShown = new Set();
const _compoundErrShown = new Set();
/*- Catastrophic scan failure (server-side lifetime scan aborted before
 *  anything persisted).  Dedup so the modal shows once per FALSE→TRUE
 *  entry — dismiss stays dismissed until the server clears the flag on
 *  a successful rescan.  See src/bot-recorder-lifetime.js
 *  `_recordScanFailure` for the source. */
const _catastrophicShown = new Set();
/*- Impermanent Loss Guard block.  Dedup so the modal shows once per
 *  FALSE→TRUE entry: the server publishes `ilGuardBlocked` on the
 *  rejection transition and nulls it when the position is allowed
 *  through again, so a dismissed modal stays dismissed for the whole
 *  episode.  See `checkIlGuard` in src/il-guard.js. */
const _ilGuardShown = new Set();

function _short(a) {
  return a ? a.slice(0, 6) + "\u2026" + a.slice(-4) : "";
}

/**
 * Build position context HTML from a specific per-position state +
 * composite key, INDEPENDENT of `posStore.getActive()`. Used by every
 * server-originated modal so the label matches the event's position,
 * not the tab the user happens to be viewing.
 * @param {string} key  Composite key: `blockchain-wallet-contract-tokenId`.
 * @param {object} st   Per-position server state.
 */
export function _posContextHtmlForState(key, st) {
  const frag = cloneTpl("tplPosContext");
  if (!frag) return "";
  const parts = key.split("-");
  const tokenId = parts.pop();
  const contract = parts.pop();
  const wallet = parts.pop();
  const ap = st?.activePosition || {};
  const t0 = ap.token0?.toLowerCase();
  const pe =
    t0 &&
    posStore.entries.find(
      (e) => e.token0?.toLowerCase() === t0 && e.fee === ap.fee,
    );
  const _s = (f) => ap[f] || pe?.[f] || "?";
  const pair = _s("token0Symbol") + "/" + _s("token1Symbol");
  const pm = botConfig.pmName || _short(contract);
  const fee = ap.fee ? (ap.fee / 10000).toFixed(2) + "% fee" : "";
  const c = botConfig.chainName;
  frag.querySelector('[data-tpl="pair"]').textContent = pair;
  frag.querySelector('[data-tpl="pm"]').textContent = pm ? " on " + pm : "";
  frag.querySelector('[data-tpl="tokenId"]').textContent = tokenId;
  frag.querySelector('[data-tpl="fee"]').textContent = fee
    ? " \u00B7 " + fee
    : "";
  frag.querySelector('[data-tpl="chain"]').textContent = c;
  frag.querySelector('[data-tpl="wallet"]').textContent = wallet || "";
  const wrap = document.createElement("div");
  wrap.appendChild(frag);
  return wrap.innerHTML;
}

function _modalIdForKey(prefix, key) {
  return prefix + "-" + key.replace(/[^a-zA-Z0-9]/g, "").slice(-16);
}

function _pausedCopy(message) {
  const m = message || "";
  const t =
    m.includes("mid-rebalance") || m.includes("Mid-rebalance")
      ? "midway"
      : m.includes("liquidity is too thin") || m.includes("no liquidity")
        ? "thin"
        : m.includes("exceeds slippage")
          ? "slip"
          : m.includes("insufficient gas")
            ? "gas"
            : m.includes("too volatile")
              ? "volatile"
              : "";
  const footers = {
    midway:
      "Tokens are safe in your wallet. The bot retried 3 times. Use the manual Rebalance button to retry.",
    thin: "Source tokens externally, recreate the LP position, then select the new NFT.",
    slip: "Adjust the slippage setting, then use the manual Rebalance button.",
    gas: "Send native tokens to the wallet address, then manual Rebalance.",
    volatile:
      "Tokens are safe in the wallet. Use the manual Rebalance button when the market calms down.",
  };
  /*- "Aborted" rather than "Paused": the bot does NOT auto-retry from
   *  the `rebalancePaused` state — every case here requires user
   *  action (bump Slippage / send gas / wait for volatility to clear).
   *  Per the project's prose discipline ([[feedback_paused_vs_aborted]]).
   *  Future cleanup [[project_split_rebalance_paused_flag]] will rename
   *  the underlying flag to match. */
  return {
    title: t ? "Rebalance Aborted" : "Rebalance Failed",
    footer: footers[t] || "The bot will keep retrying. Check logs.",
  };
}

function _showErrModal(key, st) {
  const id = _modalIdForKey("rebalanceErrorModal", key);
  if (document.getElementById(id)) return;
  const message = st.rebalanceError || "";
  const { title, footer } = _pausedCopy(message);
  _createModal(
    id,
    "",
    title,
    _posContextHtmlForState(key, st) +
      "<p>" +
      message +
      '</p><p class="9mm-pos-mgr-text-muted">' +
      footer +
      "</p>",
  );
  _errShown.add(key);
}

function _showCompoundErrModal(key, st) {
  const id = _modalIdForKey("compoundErrorModal", key);
  if (document.getElementById(id)) return;
  const message = st.compoundError || "";
  _createModal(
    id,
    "",
    "Compound Failed",
    _posContextHtmlForState(key, st) +
      "<p>" +
      message +
      '</p><p class="9mm-pos-mgr-text-muted">The bot will retry on the next auto-compound cycle. Tokens and fees remain in the position.</p>' +
      '<p class="9mm-pos-mgr-text-muted">Note: It is unlikely but possible that the Compound failed because the position went out of range during the Compound operation. If that is the case, either the next rebalance or the next check-interval will compound the fees \u2014 no need to worry.</p>',
  );
  _compoundErrShown.add(key);
}

function _showCatastrophicModal(key, st) {
  const id = _modalIdForKey("catastrophicScanErrorModal", key);
  if (document.getElementById(id)) return;
  const info = st._catastrophicScanError;
  const logPath = info.logPath;
  const message = info.message || "(no message)";
  /*- Slot ids are derived from the modal id so they are unique across
   *  every catastrophic modal that may coexist (one per position).
   *  Using ids (not data attributes) lets `document.getElementById`
   *  return the exact target unambiguously — no cross-modal clashes,
   *  no "first match wins" surprises.  Server-supplied `message` and
   *  `logPath` are still written via `textContent` (not innerHTML) so
   *  a markup-laden Error.message cannot inject HTML. */
  const msgSlotId = id + "-msg";
  const logSlotId = id + "-log";
  _createModal(
    id,
    "9mm-pos-mgr-modal-danger",
    "Catastrophic scan failure",
    _posContextHtmlForState(key, st) +
      "<p>The initial pool-wide scan for this position aborted before any data was persisted. Your Lifetime figures for this position are almost certainly wrong until the scan is re-run from scratch.</p>" +
      '<p class="9mm-pos-mgr-text-muted">Underlying error: <code id="' +
      msgSlotId +
      '"></code></p>' +
      '<p class="9mm-pos-mgr-text-muted">Full stacktrace written to <code id="' +
      logSlotId +
      '"></code> on the machine running LP Ranger.</p>' +
      "<p><strong>Dismiss this dialog, then open Settings &rarr; Reload Current Position to fix.</strong></p>",
  );
  const msgSlot = document.getElementById(msgSlotId);
  if (msgSlot) msgSlot.textContent = message;
  const logSlot = document.getElementById(logSlotId);
  if (logSlot) logSlot.textContent = logPath;
  _catastrophicShown.add(key);
}

/*- Drop a dedup entry (and dismiss its modal) once the server condition
 *  behind it has cleared.  One helper for what were five near-identical
 *  loops — adding a sixth alert should not mean copying the shape a
 *  sixth time.  `modalId` is null for alerts with no dismissable modal.
 *
 *  @param {Record<string, object>} allStates
 *  @param {Set<string>} shown      Dedup set to prune.
 *  @param {string|null} modalId    Modal id prefix, or null.
 *  @param {(st: object) => unknown} stillTrue  Condition still holding. */
function _clearWhen(allStates, shown, modalId, stillTrue) {
  for (const key of Array.from(shown)) {
    if (stillTrue(allStates[key])) continue;
    if (modalId) _dismissModalById(_modalIdForKey(modalId, key));
    shown.delete(key);
  }
}

/*- Impermanent Loss Guard blocked a rebalance.  Without this the
 *  rejection is invisible on screen: the user sees a position sitting
 *  out of range, no rebalance happening, and no reason — the
 *  explanation would exist only in Telegram and the server log.
 *
 *  The wording is NOT written here.  `checkIlGuard` (src/il-guard.js)
 *  composes it once and publishes it on `ilGuardBlocked.message`; the
 *  Telegram alert sends the same string with a manual link appended.
 *  Held as prose rather than as figures because the two channels
 *  otherwise carried five near-identical sentences that had to be
 *  copy-edited in lockstep.
 *
 *  Rendered with `createElement` + `textContent`, one paragraph per
 *  blank-line block — server text never reaches `innerHTML`. */
function _showIlGuardModal(key, st) {
  const id = _modalIdForKey("ilGuardBlockedModal", key);
  if (document.getElementById(id)) return;
  const bodyId = id + "-body";
  _createModal(
    id,
    /*- The project's existing warning shell — an Amber Yellow accent
     *  border, already used by the re-open and reload dialogs.  A
     *  warning, not a danger: the guard worked, nothing failed, and
     *  nothing is at risk. */
    "9mm-pos-mgr-warning-modal",
    "Rebalance skipped — impermanent loss",
    _posContextHtmlForState(key, st) + '<div id="' + bodyId + '"></div>',
  );
  const body = document.getElementById(bodyId);
  if (body) {
    const text = st.ilGuardBlocked?.message || "";
    for (const block of text.split("\n\n")) {
      if (!block.trim()) continue;
      const p = document.createElement("p");
      p.textContent = block;
      body.appendChild(p);
    }
  }
  _ilGuardShown.add(key);
}

function _showRecModal(key, st, minutes) {
  _createModal(
    null,
    "9mm-pos-mgr-modal-caution",
    "Position Recovered",
    _posContextHtmlForState(key, st) +
      "<p>The position was out of range and ~<strong>" +
      minutes +
      ' min</strong> of rebalance attempts did not complete (RPC, slippage, or aggregator issues).</p><p class="9mm-pos-mgr-text-muted">It has since returned to range on its own \u2014 no action needed.</p>',
  );
  _recShown.add(key);
}

function _dismissModalById(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function _clearStale(allStates) {
  for (const key of Array.from(_errShown)) {
    const st = allStates[key];
    const isPaused = !!st?.rebalancePaused;
    if (isPaused) continue;
    /*- Position is no longer paused: clear the dedup so a FUTURE
     *  failure (e.g. user retries via Manage and second attempt also
     *  aborts on slippage) can fire a fresh modal.  Without this the
     *  second attempt's `!_errShown.has(key)` guard would block the
     *  alert and the user would never see the second failure. */
    _errShown.delete(key);
    /*- Auto-dismiss the DOM modal ONLY when the position is still
     *  actively managed AND recovered (running + paused cleared via
     *  slippage change / success).  Don't dismiss after retire
     *  (status=stopped) — the user hasn't read the error yet; let
     *  them click OK when ready. */
    if (st && st.status === "running") {
      _dismissModalById(_modalIdForKey("rebalanceErrorModal", key));
    }
  }
  _clearWhen(allStates, _recShown, null, (st) => st?.oorRecoveredMin > 0);
  _clearWhen(
    allStates,
    _compoundErrShown,
    "compoundErrorModal",
    (st) => st?.compoundError,
  );
  _clearWhen(
    allStates,
    _catastrophicShown,
    "catastrophicScanErrorModal",
    (st) => st?._catastrophicScanError,
  );
  _clearWhen(
    allStates,
    _ilGuardShown,
    "ilGuardBlockedModal",
    (st) => st?.ilGuardBlocked,
  );
}

/**
 * Walk `_allPositionStates` and dispatch alerts per-position. Every
 * modal's label comes from the iterated key+state, never from
 * `posStore.getActive()`.
 * @param {object} d  Flattened status payload from /api/status.
 */
/**
 * Pure dispatch decision for the four core per-position alerts.  Given
 * the flattened states map and a snapshot of the dedup Sets, returns
 * the list of alerts that should fire this poll — the caller performs
 * the modal creation and Set mutation.  Extracted so tests can drive
 * dispatch without cloneTpl / DOM / `_createModal` side effects.
 *
 * @param {Record<string, object>} allStates
 * @param {{
 *   recShown: Set<string>,
 *   errShown: Set<string>,
 *   compoundErrShown: Set<string>,
 *   catastrophicShown: Set<string>,
 *   ilGuardShown: Set<string>,
 * }} dedup  Read-only for dispatch — caller updates on fire.
 * @returns {Array<{kind:string, key:string, message?:string}>}
 */
export function _computeCoreAlertDispatch(allStates, dedup) {
  const fired = [];
  for (const [key, st] of Object.entries(allStates)) {
    if (
      st.oorRecoveredMin > 0 &&
      !st.rebalancePaused &&
      !dedup.recShown.has(key)
    ) {
      fired.push({ kind: "recovery", key });
    }
    if (st.rebalancePaused && !dedup.errShown.has(key)) {
      fired.push({ kind: "error", key, message: st.rebalanceError });
    }
    if (st.compoundError && !dedup.compoundErrShown.has(key)) {
      fired.push({
        kind: "compoundError",
        key,
        message: st.compoundError,
      });
    }
    if (st._catastrophicScanError && !dedup.catastrophicShown.has(key)) {
      fired.push({ kind: "catastrophic", key });
    }
    if (st.ilGuardBlocked && !dedup.ilGuardShown.has(key)) {
      fired.push({ kind: "ilGuardBlocked", key });
    }
  }
  return fired;
}

export function showPerPositionAlerts(d) {
  const all = d?._allPositionStates || {};
  _clearStale(all);
  for (const [key, st] of Object.entries(all)) {
    if (st.oorRecoveredMin > 0 && !st.rebalancePaused && !_recShown.has(key)) {
      _showRecModal(key, st, st.oorRecoveredMin);
    }
    if (st.rebalancePaused && !_errShown.has(key)) {
      _showErrModal(key, st);
    }
    if (st.compoundError && !_compoundErrShown.has(key)) {
      _showCompoundErrModal(key, st);
    }
    if (st._catastrophicScanError && !_catastrophicShown.has(key)) {
      _showCatastrophicModal(key, st);
    }
    if (st.ilGuardBlocked && !_ilGuardShown.has(key)) {
      _showIlGuardModal(key, st);
    }
  }
  showPostRebalanceWarnings(all, _createModal, _posContextHtmlForState);
}

/** Test-only reset for dedup state. */
export function _resetAlertsState() {
  _ilGuardShown.clear();
  _errShown.clear();
  _recShown.clear();
  _compoundErrShown.clear();
  _catastrophicShown.clear();
}
