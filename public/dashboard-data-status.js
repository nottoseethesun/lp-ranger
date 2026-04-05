/**
 * @file dashboard-data-status.js
 * @description Bot status display, alerts, modals, position context helpers,
 * and UI update functions. Split from dashboard-data.js.
 */
import {
  g,
  botConfig,
  fmtDateTime,
  fmtReset,
  truncName,
  fmtNum,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import {
  _fmtDuration,
  _activeToken1Symbol,
  updateRangePctLabels,
  positionRangeVisual,
} from "./dashboard-data-kpi.js";

let _errorModalShown = false,
  _recoveryModalShown = false,
  _rangeRoundedShown = false;

function _dismissRebalanceModal() {
  const el = document.getElementById("rebalanceErrorModal");
  if (el) el.remove();
  _errorModalShown = false;
}

/** Create and append a modal overlay to the document body. */
export function _createModal(id, cssClass, title, bodyHtml) {
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  if (id) o.id = id;
  o.innerHTML =
    '<div class="9mm-pos-mgr-modal ' +
    cssClass +
    '"><h3>' +
    title +
    '</h3><div class="9mm-pos-mgr-modal-body">' +
    bodyHtml +
    '</div><button class="9mm-pos-mgr-modal-close"' +
    " data-dismiss-modal>OK</button></div>";
  document.body.appendChild(o);
}

function _short(addr) {
  return addr ? addr.slice(0, 6) + "\u2026" + addr.slice(-4) : "";
}

/** Build a one-line position label: pair + PM + NFT + fee + chain + wallet. */
export function _posLabel() {
  const a = posStore.getActive();
  if (!a) return "";
  const pair = (a.token0Symbol || "?") + "/" + (a.token1Symbol || "?");
  const pm = botConfig.pmName || _short(a.contractAddress);
  const c = botConfig.chainName || "PulseChain",
    fee = a.fee ? (a.fee / 10000).toFixed(2) + "%" : "";
  return (
    pair +
    (pm ? " on " + pm : "") +
    " \u00B7 NFT #" +
    a.tokenId +
    (fee ? " \u00B7 " + fee : "") +
    " \u00B7 " +
    c +
    " \u00B7 " +
    _short(a.walletAddress)
  );
}

/** Build an HTML paragraph with position context for modal bodies. */
export function _posContextHtml() {
  const a = posStore.getActive();
  if (!a) return "";
  const pair = (a.token0Symbol || "?") + "/" + (a.token1Symbol || "?");
  const pm = botConfig.pmName || _short(a.contractAddress);
  const fee = a.fee ? (a.fee / 10000).toFixed(2) + "% fee" : "";
  const c = botConfig.chainName || "PulseChain";
  return (
    '<p class="9mm-pos-mgr-text-muted">' +
    pair +
    (pm ? " on " + pm : "") +
    "<br>NFT #" +
    a.tokenId +
    (fee ? " \u00B7 " + fee : "") +
    "<br>" +
    c +
    " \u00B7 " +
    _short(a.walletAddress) +
    "</p>"
  );
}

/** Append position label to a title via em-dash. */
export function _titled(base) {
  const p = _posLabel();
  return p ? base + " \u2014 " + p : base;
}

/** Build a multi-line context string for activity log entries. */
export function _logCtx(key, st) {
  const ap = st?.activePosition;
  if (!ap) return "";
  const t0 = ap.token0?.toLowerCase(),
    pe = posStore.entries.find(
      (e) => e.token0?.toLowerCase() === t0 && e.fee === ap.fee,
    );
  const _s = (f) => ap[f] || pe?.[f] || "?";
  const pair = _s("token0Symbol") + "/" + _s("token1Symbol");
  const pm = botConfig.pmName,
    c = botConfig.chainName || "PulseChain";
  const fee = ap.fee ? (ap.fee / 10000).toFixed(2) + "%" : "";
  const parts = key.split("-");
  return (
    "\n" +
    pair +
    (pm ? " on " + pm : "") +
    " \u00B7 NFT #" +
    parts.pop() +
    (fee ? " \u00B7 " + fee : "") +
    " \u00B7 " +
    c +
    " \u00B7 " +
    _short(parts[1] || "")
  );
}

function _showRebalanceErrorModal(message) {
  if (_errorModalShown || !message) return;
  _errorModalShown = true;
  _recoveryModalShown = false;
  const m = message;
  const t =
    m.includes("liquidity is too thin") || m.includes("no liquidity")
      ? "thin"
      : m.includes("exceeds slippage")
        ? "slip"
        : m.includes("insufficient gas")
          ? "gas"
          : "";
  const _footers = {
    thin: "Source tokens externally, recreate the LP position, then select the new NFT.",
    slip: "Adjust the slippage setting, then use the manual Rebalance button.",
    gas: "Send native tokens to the wallet address, then manual Rebalance.",
  };
  const footer = _footers[t] || "The bot will keep retrying. Check logs.";
  _createModal(
    "rebalanceErrorModal",
    "",
    t ? "Rebalance Paused" : "Rebalance Failing",
    _posContextHtml() +
      "<p>" +
      message +
      '</p><p class="9mm-pos-mgr-text-muted">' +
      footer +
      "</p>",
  );
}

function _showRecoveryModal(minutes) {
  if (_recoveryModalShown) return;
  _recoveryModalShown = true;
  _createModal(
    null,
    "9mm-pos-mgr-modal-caution",
    "Position Recovered",
    _posContextHtml() +
      "<p>Price returned to range after ~<strong>" +
      minutes +
      ' min</strong> of failed attempts.</p><p class="9mm-pos-mgr-text-muted">No rebalance needed.</p>',
  );
}

function _activeTokenNames() {
  const a = posStore.getActive();
  const t0 = a?.token0Symbol || "Token 0",
    t1 = a?.token1Symbol || "Token 1";
  return {
    t0: truncName(t0, 12),
    t1: truncName(t1, 12),
    t0Full: t0,
    t1Full: t1,
  };
}

/** Update token composition bar and labels. */
export function _updateComposition(d) {
  if (!d.positionStats) return;
  const r0 = d.positionStats.compositionRatio ?? 0.5;
  const c0 = g("c0"),
    c1 = g("c1");
  if (c0) c0.style.width = (r0 * 100).toFixed(1) + "%";
  if (c1) c1.style.width = ((1 - r0) * 100).toFixed(1) + "%";
  const tn = _activeTokenNames(),
    cl0 = g("cl0"),
    cl1 = g("cl1");
  if (cl0) {
    cl0.textContent = "\u25A0 " + tn.t0 + ": " + (r0 * 100).toFixed(0) + "%";
    cl0.title = tn.t0Full;
  }
  if (cl1) {
    cl1.textContent =
      "\u25A0 " + tn.t1 + ": " + ((1 - r0) * 100).toFixed(0) + "%";
    cl1.title = tn.t1Full;
  }
  const sl0 = g("statT0Label"),
    sl1 = g("statT1Label");
  if (sl0) {
    sl0.textContent = tn.t0;
    sl0.title = tn.t0Full;
  }
  if (sl1) {
    sl1.textContent = tn.t1;
    sl1.title = tn.t1Full;
  }
  const sh0 = g("statShare0Label"),
    sh1 = g("statShare1Label");
  if (sh0) {
    sh0.textContent = "Pool Share " + tn.t0;
    sh0.title = tn.t0Full;
  }
  if (sh1) {
    sh1.textContent = "Pool Share " + tn.t1;
    sh1.title = tn.t1Full;
  }
  const ps = d.positionStats,
    sw = g("sWpls"),
    su = g("sUsdc");
  if (ps.balance0 !== undefined && sw) sw.textContent = ps.balance0;
  if (ps.balance1 !== undefined && su) su.textContent = ps.balance1;
}

/** Update tick labels and pool share percentages. */
export function _updatePositionTicks(d) {
  if (d.poolState) {
    const tc = g("sTC");
    if (tc) tc.textContent = d.poolState.tick ?? "\u2014";
  }
  if (!d.activePosition) return;
  const pos = d.activePosition,
    tl = g("sTL"),
    tu = g("sTU");
  if (tl) tl.textContent = pos.tickLower ?? "\u2014";
  if (tu) tu.textContent = pos.tickUpper ?? "\u2014";
  if (d.positionStats) {
    const s0 = g("sShare0"),
      s1 = g("sShare1");
    if (s0)
      s0.textContent =
        d.positionStats.poolShare0Pct !== undefined
          ? d.positionStats.poolShare0Pct.toFixed(4) + "%"
          : "\u2014";
    if (s1)
      s1.textContent =
        d.positionStats.poolShare1Pct !== undefined
          ? d.positionStats.poolShare1Pct.toFixed(4) + "%"
          : "\u2014";
  }
  const oor = g("sOorDuration");
  if (oor)
    oor.textContent = botConfig.oorSince
      ? _fmtDuration(Date.now() - botConfig.oorSince)
      : "n/a";
}

/** Format a TX hash as a short copy-to-clipboard span. */
export function _fmtTxCopy(hash) {
  const short = hash.slice(0, 4) + "\u2026" + hash.slice(-4);
  return (
    '<span class="9mm-pos-mgr-copy-icon" title="Copy full TX hash"' +
    ' data-copy-tx="' +
    hash +
    '">' +
    short +
    " &#x274F;</span>"
  );
}

/**
 * Update the ACTIVE / CLOSED status pill for the current position.
 * @param {object} d  Flattened status data.
 * @param {boolean} scanWasComplete  Whether the initial position scan finished.
 */
export function _updatePosStatus(d, scanWasComplete) {
  const el = g("curPosStatus");
  if (!el) return;
  const active = posStore.getActive();
  if (!active) {
    el.textContent = "";
    el.className = "9mm-pos-mgr-pos-status";
    return;
  }
  const ap = d.activePosition;
  // Server data is authoritative. Before scan completes, posStore
  // has stale localStorage data — don't trust it for status display.
  const liq = ap
    ? (ap.liquidity ?? active.liquidity)
    : scanWasComplete
      ? active.liquidity
      : null;
  if (liq === null || liq === undefined) {
    el.textContent = "";
    el.className = "9mm-pos-mgr-pos-status";
    return;
  }
  const isClosed = BigInt(liq) === 0n;
  el.textContent = isClosed ? "CLOSED" : "ACTIVE";
  el.className = "9mm-pos-mgr-pos-status " + (isClosed ? "closed" : "active");
}

/** Set the bot status pill (dot + label + tooltip). */
export function _setStatusPill(pillCls, dotCls, label, tip) {
  const pill = g("botStatusPill"),
    dot = g("botDot"),
    text = g("botStatusText");
  if (pill) {
    pill.className = pillCls;
    pill.title = tip || "";
  }
  if (dot) dot.className = dotCls;
  if (text) text.textContent = label;
}

/** Update the price marker and range boundaries from pool state. */
export function _updatePriceMarker(d) {
  if (!d.poolState) return;
  const a = posStore.getActive();
  if (a && !isPositionManaged(a.tokenId)) return;
  botConfig.price = d.poolState.price;
  const pml = g("pmlabel");
  if (pml) {
    pml.textContent = fmtNum(d.poolState.price) + " " + _activeToken1Symbol();
    pml.title = d.poolState.price.toString();
  }
  if (d.activePosition) {
    botConfig.tL = d.activePosition.tickLower || 0;
    botConfig.tU = d.activePosition.tickUpper || 0;
    const _d0 = d.poolState.decimals0,
      _d1 = d.poolState.decimals1;
    const decAdj =
      _d0 !== undefined && _d1 !== undefined ? Math.pow(10, _d0 - _d1) : 1;
    botConfig.lower = Math.pow(1.0001, botConfig.tL) * decAdj;
    botConfig.upper = Math.pow(1.0001, botConfig.tU) * decAdj;
  }
  updateRangePctLabels(d.poolState.price, botConfig.lower, botConfig.upper);
  positionRangeVisual();
}

function _setIdlePill(d) {
  const mp = d._managedPositions || [];
  if (mp.some((p) => p.status === "running"))
    return _setStatusPill("status-pill active", "dot green", "MANAGING");
  _setStatusPill(
    "status-pill warning",
    "dot yellow",
    "IDLE",
    mp.length === 0
      ? "No positions are being managed. After syncing, select a position and click Manage."
      : "",
  );
}

function _showAlerts(d) {
  if (d.oorRecoveredMin > 0 && !d.rebalancePaused && !_recoveryModalShown) {
    _dismissRebalanceModal();
    _showRecoveryModal(d.oorRecoveredMin);
  }
  if (d.rangeRounded && !_rangeRoundedShown) {
    _rangeRoundedShown = true;
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Range Width Adjusted",
      _posContextHtml() +
        "<p>Requested <strong>" +
        d.rangeRounded.requested +
        "%</strong> but tick spacing rounded to <strong>" +
        d.rangeRounded.effective +
        '%</strong>.</p><p class="9mm-pos-mgr-text-muted">V3 uses tick-spacing multiples.</p>',
    );
  }
  if (d.rebalancePaused) _showRebalanceErrorModal(d.rebalanceError);
}

/** Update the bot status pill, alerts, price marker, and last-check labels. */
export function _updateBotStatus(d) {
  _showAlerts(d);
  if (d.rebalancePaused) {
    _setStatusPill("status-pill danger", "dot red", "RETRYING");
  } else if (d.halted) {
    _setStatusPill("status-pill danger", "dot red", "HALTED");
  } else if (d.running) {
    _setStatusPill("status-pill active", "dot green", "RUNNING");
  } else {
    _setIdlePill(d);
  }
  _updatePriceMarker(d);
  const tag = g("lastCheckTag");
  if (tag && d.updatedAt) {
    const ms = Date.now() - new Date(d.updatedAt).getTime();
    const ago = Math.floor(ms / 1000);
    tag.textContent = ago < 5 ? "just now" : ago + "s ago";
    tag.title = fmtDateTime(d.updatedAt);
  }
  const ll = g("lastCheckLabel");
  if (ll && d.updatedAt) ll.textContent = fmtDateTime(d.updatedAt);
}

function _normalizedPoolKey(pos) {
  if (!pos?.token0 || !pos?.token1 || !pos?.fee) return null;
  const a = pos.token0.toLowerCase(),
    b = pos.token1.toLowerCase();
  return (a < b ? a + "-" + b : b + "-" + a) + "-" + pos.fee;
}

/** Update the daily rebalance count KPI and lifetime count. */
export function _updateThrottleKpis(d) {
  const ts = d.throttleState,
    today = g("kpiToday");
  if (today) {
    const max = (ts && ts.dailyMax) || d.maxRebalancesPerDay || null;
    const pk = _normalizedPoolKey(posStore.getActive());
    const cnt =
      pk && d._poolDailyCounts
        ? d._poolDailyCounts[pk] || 0
        : ts
          ? ts.dailyCount
          : 0;
    if (!max) {
      today.textContent = "\u2014";
      today.style.color = "";
    } else {
      const r = cnt / max;
      today.textContent = cnt + " / " + max;
      today.style.color =
        r >= 0.9
          ? "#ff3b5c"
          : r >= 0.66
            ? "#ff6b35"
            : r >= 0.5
              ? "#ffb800"
              : "#e0eaf4";
    }
  }
  const sub = g("kpiTodaySub");
  if (sub) {
    const lt = d.rebalanceEvents ? d.rebalanceEvents.length : 0;
    sub.innerHTML = lt + " Lifetime<br>" + fmtReset(ts?.dailyResetAt);
  }
}

/** Sync the auto-compound toggle, badge, and threshold from server status data. */
export function _syncAutoCompound(d) {
  const on = !!d.autoCompoundEnabled;
  const cb = g("autoCompoundToggle");
  if (cb) cb.checked = on;
  const badge = g("autoCompoundBadge");
  if (badge) {
    badge.textContent = on ? "ON" : "OFF";
    badge.className = "9mm-pos-mgr-mission-badge " + (on ? "on" : "off");
  }
  const th = g("autoCompoundThreshold");
  if (th && document.activeElement !== th) {
    th.value =
      d.autoCompoundThresholdUsd || botConfig.compoundDefaultThreshold || 5;
  }
}

/** Enable/disable the Compound Now button based on fee threshold. */
export function _updateCompoundButton(d, rebInProgress) {
  const cb = g("compoundNowBtn");
  if (!cb) return;
  const minFee = botConfig.compoundMinFee || 1;
  // Read fees from snapshot or from the displayed KPI (covers unmanaged positions)
  let feesUsd = d.pnlSnapshot?.liveEpoch?.fees || 0;
  if (!feesUsd) {
    const el = g("pnlFees");
    if (el) feesUsd = parseFloat(el.textContent.replace(/[^0-9.-]/g, "")) || 0;
  }
  const canCompound =
    !rebInProgress && !d.compoundInProgress && feesUsd >= minFee;
  cb.disabled = !canCompound;
  cb.title = canCompound
    ? ""
    : "Enabled when Fees available are > $usd " + minFee;
}
