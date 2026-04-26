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
  fmtDuration,
  cloneTpl,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import { throttle } from "./dashboard-throttle.js";
import {
  _activeToken1Symbol,
  updateRangePctLabels,
  positionRangeVisual,
} from "./dashboard-data-kpi.js";
import { showPerPositionAlerts } from "./dashboard-alerts.js";

/**
 * Create and append a modal overlay to the document body. The shell
 * (modal div, h3, body div, close button) comes from the tplStatusModal
 * <template>; bodyHtml is still injected via innerHTML on the body div
 * — Phase 2 of the html-cleanup pass will convert callers to pass a
 * DocumentFragment instead of a string.
 */
export function _createModal(id, cssClass, title, bodyHtml) {
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  if (id) o.id = id;
  const frag = cloneTpl("tplStatusModal");
  if (frag) {
    const inner = frag.querySelector('[data-tpl="inner"]');
    if (cssClass) {
      for (const c of cssClass.split(/\s+/).filter(Boolean))
        inner.classList.add(c);
    }
    frag.querySelector('[data-tpl="title"]').textContent = title;
    frag.querySelector('[data-tpl="body"]').innerHTML = bodyHtml;
    o.appendChild(frag);
  }
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

/**
 * Build an HTML paragraph with position context for modal bodies.
 * The structure comes from the tplPosContext <template>; we populate
 * [data-tpl] slots via textContent and return the serialized outerHTML
 * so existing string-concat callers continue to work unchanged.
 */
export function _posContextHtml() {
  const a = posStore.getActive();
  if (!a) return "";
  const frag = cloneTpl("tplPosContext");
  if (!frag) return "";
  const pair = (a.token0Symbol || "?") + "/" + (a.token1Symbol || "?");
  const pm = botConfig.pmName || _short(a.contractAddress);
  const fee = a.fee ? (a.fee / 10000).toFixed(2) + "% fee" : "";
  const c = botConfig.chainName || "PulseChain";
  frag.querySelector('[data-tpl="pair"]').textContent = pair;
  frag.querySelector('[data-tpl="pm"]').textContent = pm ? " on " + pm : "";
  frag.querySelector('[data-tpl="tokenId"]').textContent = a.tokenId;
  frag.querySelector('[data-tpl="fee"]').textContent = fee
    ? " \u00B7 " + fee
    : "";
  frag.querySelector('[data-tpl="chain"]').textContent = c;
  frag.querySelector('[data-tpl="wallet"]').textContent = _short(
    a.walletAddress,
  );
  const wrap = document.createElement("div");
  wrap.appendChild(frag);
  return wrap.innerHTML;
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

function _activeTokenNames() {
  const a = posStore.getActive();
  const t0 = a?.token0Symbol || "Token 0",
    t1 = a?.token1Symbol || "Token 1";
  return {
    t0: truncName(t0, 28),
    t1: truncName(t1, 28),
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
  const sl0 = g("statT0Name"),
    sl1 = g("statT1Name");
  if (sl0) sl0.textContent = tn.t0;
  if (sl1) sl1.textContent = tn.t1;
  if (sl0) sl0.parentElement.title = tn.t0Full;
  if (sl1) sl1.parentElement.title = tn.t1Full;
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
  _updateResiduals(d);
}

/** Update the per-token Residual values (coins left liquid on the wallet). */
function _updateResiduals(d) {
  const snap = d.pnlSnapshot;
  const r0 = g("sResidual0"),
    r1 = g("sResidual1");
  const fmt = (v) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(3) : "\u2014";
  if (r0) r0.textContent = fmt(snap?.residualAmount0);
  if (r1) r1.textContent = fmt(snap?.residualAmount1);
  const tip0 = g("sResidual0Tip"),
    tip1 = g("sResidual1Tip");
  const usdFmt = (v) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(2) : "0.00";
  if (tip0)
    tip0.textContent = `Coins left liquid on the wallet; ~ $usd ${usdFmt(snap?.residualUsd0)}.`;
  if (tip1)
    tip1.textContent = `Coins left liquid on the wallet; ~ $usd ${usdFmt(snap?.residualUsd1)}.`;
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
          ? "Pool Share: " + d.positionStats.poolShare0Pct.toFixed(4) + "% "
          : "\u2014";
    if (s1)
      s1.textContent =
        d.positionStats.poolShare1Pct !== undefined
          ? "Pool Share: " + d.positionStats.poolShare1Pct.toFixed(4) + "% "
          : "\u2014";
  }
  const oor = g("sOorDuration");
  if (oor)
    oor.textContent = botConfig.oorSince
      ? fmtDuration(Date.now() - botConfig.oorSince)
      : "n/a";
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
  botConfig.price = d.poolState.price;
  const _ap = posStore.getActive();
  if (d.poolState.poolAddress && _ap) _ap.poolAddress = d.poolState.poolAddress;
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
  const a = posStore.getActive();
  if (a && !isPositionManaged(a.tokenId)) return;
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

/** Update the bot status pill, alerts, price marker, and last-check labels. */
export function _updateBotStatus(d) {
  showPerPositionAlerts(d);
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

/*-
 * Server is the source of truth for the throttle counters. Sync them
 * back into the client `throttle` object so the badge in
 * dashboard-throttle.js renders correctly without depending on HTML
 * input defaults. Without this, an empty inMaxReb input at init
 * leaves throttle.dailyMax = 0, and `0 >= 0` paints a false CAPPED
 * badge.
 */
function _syncClientThrottle(ts, cnt) {
  if (!ts) return;
  throttle.dailyCount = cnt;
  if (typeof ts.dailyMax === "number") throttle.dailyMax = ts.dailyMax;
  if (typeof ts.doublingActive === "boolean")
    throttle.doublingActive = ts.doublingActive;
  if (typeof ts.doublingCount === "number")
    throttle.doublingCount = ts.doublingCount;
  if (typeof ts.currentWaitMs === "number")
    throttle.currentWaitMs = ts.currentWaitMs;
  if (typeof ts.lastRebTime === "number") throttle.lastRebTime = ts.lastRebTime;
  if (typeof ts.minIntervalMs === "number")
    throttle.minIntervalMs = ts.minIntervalMs;
}

/*-
 * "Today's Rebalances" X / Y and its sub-line are rebalance-control
 * status — meaningless for Unmanaged positions. Render "N/A" with the
 * standard tooltip rather than letting client defaults paint a stale
 * 0 / 0 or "0 Lifetime". See project_unmanaged_na_principle in
 * memory.
 */
const _NA_TOOLTIP_THROTTLE = "Only for Managed Positions";

function _renderThrottleKpisNa() {
  const today = g("kpiToday");
  if (today) {
    today.textContent = "N/A";
    today.style.color = "";
    today.title = _NA_TOOLTIP_THROTTLE;
  }
  /*- Set textContent to "N/A" but visually hide — keeps a debuggable
      value in the DOM without showing two stacked "N/A"s in the card. */
  const sub = g("kpiTodaySub");
  if (sub) {
    sub.replaceChildren(document.createTextNode("N/A"));
    sub.title = _NA_TOOLTIP_THROTTLE;
    sub.hidden = true;
  }
}

/** Color for the daily-count KPI based on usage ratio. */
function _todayColor(r) {
  if (r >= 0.9) return "#ff3b5c";
  if (r >= 0.66) return "#ff6b35";
  if (r >= 0.5) return "#ffb800";
  return "#e0eaf4";
}

/** Paint the "Today's Rebalances" X / Y KPI for a managed position. */
function _renderTodayKpi(today, cnt, max) {
  if (!today) return;
  today.title = "";
  if (!max) {
    today.textContent = "\u2014";
    today.style.color = "";
    return;
  }
  today.textContent = cnt + " / " + max;
  today.style.color = _todayColor(cnt / max);
}

/** Paint the sub-line under the daily-count KPI. */
function _renderTodaySub(d, ts) {
  const sub = g("kpiTodaySub");
  if (!sub) return;
  sub.title = "";
  sub.hidden = false;
  const lt = d.rebalanceEvents ? d.rebalanceEvents.length : 0;
  sub.replaceChildren(
    document.createTextNode(lt + " Lifetime"),
    document.createElement("br"),
    document.createTextNode(fmtReset(ts?.dailyResetAt)),
  );
}

/** Update the daily rebalance count KPI and lifetime count. */
export function _updateThrottleKpis(d) {
  const a = posStore.getActive();
  if (a && !isPositionManaged(a.tokenId)) {
    _renderThrottleKpisNa();
    return;
  }
  const ts = d.throttleState;
  // Server attaches a canonical `poolKey` to each managed position
  // (chain-contract-wallet-token0-token1-fee). Use it directly — no
  // client-side reconstruction, so the lookup always matches.
  const pk = d.poolKey;
  const cnt =
    pk && d._poolDailyCounts
      ? d._poolDailyCounts[pk] || 0
      : ts
        ? ts.dailyCount
        : 0;
  _syncClientThrottle(ts, cnt);
  const max = (ts && ts.dailyMax) || d.maxRebalancesPerDay || null;
  _renderTodayKpi(g("kpiToday"), cnt, max);
  _renderTodaySub(d, ts);
}

/** Sync the auto-compound toggle, badge, and threshold from server status data. */
let _suppressAutoCompoundUntil = 0;

/** Suppress auto-compound sync for a brief window (e.g. after Stop Managing). */
export function suppressAutoCompoundSync(ms) {
  _suppressAutoCompoundUntil = Date.now() + (ms || 5000);
}

export function _syncAutoCompound(d) {
  if (Date.now() < _suppressAutoCompoundUntil) return;
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
