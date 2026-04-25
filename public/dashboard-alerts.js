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
  const c = botConfig.chainName || "PulseChain";
  frag.querySelector('[data-tpl="pair"]').textContent = pair;
  frag.querySelector('[data-tpl="pm"]').textContent = pm ? " on " + pm : "";
  frag.querySelector('[data-tpl="tokenId"]').textContent = tokenId;
  frag.querySelector('[data-tpl="fee"]').textContent = fee
    ? " \u00B7 " + fee
    : "";
  frag.querySelector('[data-tpl="chain"]').textContent = c;
  frag.querySelector('[data-tpl="wallet"]').textContent = _short(wallet);
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
  return {
    title: t ? "Rebalance Paused" : "Rebalance Failed",
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
    if (!allStates[key]?.rebalancePaused) {
      _dismissModalById(_modalIdForKey("rebalanceErrorModal", key));
      _errShown.delete(key);
    }
  }
  for (const key of Array.from(_recShown)) {
    if (!(allStates[key]?.oorRecoveredMin > 0)) _recShown.delete(key);
  }
  for (const key of Array.from(_compoundErrShown)) {
    if (!allStates[key]?.compoundError) {
      _dismissModalById(_modalIdForKey("compoundErrorModal", key));
      _compoundErrShown.delete(key);
    }
  }
}

/**
 * Walk `_allPositionStates` and dispatch alerts per-position. Every
 * modal's label comes from the iterated key+state, never from
 * `posStore.getActive()`.
 * @param {object} d  Flattened status payload from /api/status.
 */
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
  }
  showPostRebalanceWarnings(all, _createModal, _posContextHtmlForState);
}

/** Test-only reset for dedup state. */
export function _resetAlertsState() {
  _errShown.clear();
  _recShown.clear();
  _compoundErrShown.clear();
}
