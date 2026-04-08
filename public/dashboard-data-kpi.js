/**
 * @file dashboard-data-kpi.js
 * @description KPI calculation and display for the
 * 9mm v3 Position Manager dashboard.
 * Split from dashboard-data.js.
 */
import { g, truncName, fmtDateTime, botConfig } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import {
  _poolKey,
  loadRealizedGains,
  loadCurRealized,
  loadInitialDeposit,
  loadCurDeposit,
  refreshCurDepositDisplay,
} from "./dashboard-data-deposit.js";

let _poolFirstDate = null;
export function setPoolFirstDate(d) {
  _poolFirstDate = d;
}
export function getPoolFirstDate() {
  return _poolFirstDate;
}

/** Format a number as USD. */
export function _fmtUsd(val) {
  if (val === null || val === undefined || isNaN(val)) return "\u2014";
  const abs = Math.abs(val).toFixed(2);
  return abs === "0.00" ? "$usd 0.00" : (val < 0 ? "-" : "") + "$usd " + abs;
}
export function _isDisplayZero(val) {
  return Math.abs(val).toFixed(2) === "0.00";
}
export function _setPctSpan(id, val, deposit) {
  const el = g(id);
  if (!el) return;
  if (!deposit || deposit <= 0) {
    el.textContent = "";
    return;
  }
  const pct = (val / deposit) * 100,
    r = pct.toFixed(2),
    z = r === "0.00" || r === "-0.00";
  el.textContent = (z ? "" : pct > 0 ? "+" : "") + (z ? "0.00" : r) + "%";
}
export function _setAprSpan(id, val, deposit, firstDate) {
  const el = g(id);
  if (!el) return;
  if (!deposit || deposit <= 0 || !firstDate) {
    el.textContent = "\u2014";
    return;
  }
  const sec =
    (Date.now() - new Date(firstDate + "T00:00:00Z").getTime()) / 1000;
  if (sec <= 0) {
    el.textContent = "\u2014";
    return;
  }
  const apr = (val / deposit / (sec / (365.25 * 86400))) * 100;
  if (Math.abs(apr) < 0.005) {
    el.textContent = "APR 0.00%";
    el.style.color = "";
    return;
  }
  el.textContent =
    (apr > 0
      ? "APR " + apr.toFixed(2)
      : "APR \u2212" + Math.abs(apr).toFixed(2)) + "%";
  el.style.color = apr > 0 ? "#0f0" : "#f44";
}
export function _setLeadingText(el, text) {
  if (!el) return;
  if (el.firstChild?.nodeType === 3) el.firstChild.textContent = text;
  else el.insertBefore(document.createTextNode(text), el.firstChild);
}
/** Reset KPIs to dashes. */
export function resetKpis(ids) {
  for (const id of ids) {
    const el = g(id);
    if (el) {
      el.textContent = "\u2014";
      el.className = "kpi-value neu";
    }
  }
}
const _CUR_KPI_IDS = [
  "kpiValue",
  "pnlFees",
  "pnlCompounded",
  "pnlGas",
  "pnlPrice",
  "pnlRealized",
  "curProfit",
  "curIL",
];
export function _resetCurrentKpis() {
  resetKpis(_CUR_KPI_IDS);
  _setDepositDisplay(0);
}
/** Set KPI with USD value and sign-colored class. */
export function setKpiValue(id, val) {
  const el = g(id);
  if (!el) return;
  if (val === null || val === undefined) {
    el.textContent = "\u2014";
    el.className = "kpi-value neu";
    return;
  }
  const cls = _isDisplayZero(val) ? "neu" : val > 0 ? "pos" : "neg";
  el.textContent = _fmtUsd(val);
  el.className = el.className
    .replace(/\b(pos|neg|neu)\b/g, "")
    .replace(/\bkpi-value\b/, "")
    .trim();
  el.classList.add("kpi-value", cls);
}
export function _updatePnlHeader(d, total, realized, curDeposit) {
  const pnl = g("kpiPnl"),
    pnlSub = g("kpiPnlPct");
  if (d.pnlSnapshot) {
    _setLeadingText(pnl, _fmtUsd(total));
    pnl.className =
      "kpi-value 9mm-pos-mgr-kpi-pct-row " +
      (_isDisplayZero(total) ? "neu" : total > 0 ? "pos" : "neg");
    _setPctSpan("kpiPnlPctVal", total, curDeposit);
    const posStart = d.hodlBaseline?.mintDate || null;
    _setAprSpan("kpiPnlApr", total, curDeposit, posStart);
    if (posStart) {
      pnlSub.textContent =
        fmtDateTime(posStart + "T00:00:00Z", { dateOnly: true }) +
        " \u2192 " +
        fmtDateTime(d.pnlSnapshot.snapshotDateUtc + "T00:00:00Z", {
          dateOnly: true,
        });
    } else pnlSub.textContent = "cumulative";
  } else if (d.running) {
    if (realized > 0) {
      _setLeadingText(pnl, _fmtUsd(realized));
      pnl.className = "kpi-value 9mm-pos-mgr-kpi-pct-row pos";
    }
    pnlSub.textContent = "Awaiting First P\u0026L Snapshot";
  }
}
/** Format a duration in ms as "Xd Yh Zm". */
export function _fmtDuration(ms) {
  const d = Math.floor(ms / 86400000),
    h = Math.floor((ms % 86400000) / 3600000),
    m = Math.floor((ms % 3600000) / 60000);
  return (d > 0 ? d + "d " : "") + (h > 0 || d > 0 ? h + "h " : "") + m + "m";
}
export function _updateCurIL(d, deposit) {
  const raw = d.pnlSnapshot ? d.pnlSnapshot.totalIL : undefined;
  const el = g("curIL");
  if (el) {
    if (raw === null || raw === undefined) {
      _setLeadingText(el, "\u2014");
      el.className = "kpi-value 9mm-pos-mgr-kpi-pct-row neu";
    } else {
      _setLeadingText(el, _fmtUsd(raw));
      el.className =
        "kpi-value 9mm-pos-mgr-kpi-pct-row " +
        (_isDisplayZero(raw) ? "neu" : raw > 0 ? "pos" : "neg");
    }
  }
  _setPctSpan("curILPct", raw ?? 0, deposit);
}
export function _updatePosDuration(d) {
  const el = g("kpiPosDuration");
  if (!el) return;
  const mt =
    d.positionMintTimestamp ||
    d.hodlBaseline?.mintDate ||
    d.hodlBaseline?.mintTimestamp;
  if (!mt) {
    el.textContent = "\u2014";
    return;
  }
  const ms =
    typeof mt === "number"
      ? Date.now() - mt * 1000
      : Date.now() -
        (mt.includes("T")
          ? new Date(mt).getTime()
          : new Date(mt + "T00:00:00Z").getTime());
  el.textContent =
    ms > 0
      ? "Active: " + _fmtDuration(ms) + " \u00B7 Minted: " + fmtDateTime(mt)
      : "";
}
export function _applySnapshotKpis(d, deposit, curRealized) {
  const ep = d.pnlSnapshot.liveEpoch,
    cv = d.pnlSnapshot.currentValue || 0;
  const val = g("kpiValue");
  if (val) val.textContent = _fmtUsd(cv);
  const curFees = ep ? ep.fees || 0 : 0;
  setKpiValue("pnlFees", curFees);
  const curCompounded = d.pnlSnapshot.currentCompoundedUsd || 0;
  setKpiValue("pnlCompounded", curCompounded > 0 ? curCompounded : null);
  const curGas = d.pnlSnapshot.totalGas || 0;
  if (curGas > 0 && curGas < 0.01) {
    const el = g("pnlGas");
    if (el) {
      el.textContent = "< $0.01";
      el.className = el.className.replace(/\b(pos|neg|neu)\b/g, "").trim();
      el.classList.add("neg");
    }
  } else {
    setKpiValue("pnlGas", curGas > 0 ? curGas : null);
  }
  setKpiValue("pnlPrice", deposit > 0 ? cv - deposit : 0);
  setKpiValue("pnlRealized", curRealized);
  _updateCurIL(d, deposit);
  _updatePosDuration(d);
  _setProfitKpi(
    "curProfit",
    curFees,
    ep ? ep.gas || 0 : 0,
    d.pnlSnapshot.totalIL,
    curCompounded,
  );
}
export function _botDetectedDeposit(d) {
  if (d.initialDepositUsd > 0) return d.initialDepositUsd;
  if (d.hodlBaseline?.entryValue > 0) return d.hodlBaseline.entryValue;
  return d.pnlSnapshot ? d.pnlSnapshot.initialDeposit || 0 : 0;
}
export function _resolveCurDeposit(d) {
  const saved = loadCurDeposit() || loadInitialDeposit();
  if (saved > 0) return saved;
  const bl = d.hodlBaseline?.entryValue || 0,
    lv = d.pnlSnapshot?.liveEpoch?.entryValue || 0;
  return d._hasPositionData ? (bl > 0 ? bl : lv) : 0;
}
export function _priceChangePnl(d, deposit) {
  return d.pnlSnapshot && deposit > 0
    ? (d.pnlSnapshot.currentValue || 0) - deposit
    : 0;
}
export function _resolveKpiTotals(d) {
  const ltRealized = loadRealizedGains(),
    curRealized = loadCurRealized();
  const ltFees = d.pnlSnapshot ? d.pnlSnapshot.totalFees || 0 : 0;
  const curFees = d.pnlSnapshot?.liveEpoch?.fees || 0;
  const curDep = _resolveCurDeposit(d),
    ltUserDep = loadInitialDeposit();
  const ltDep = ltUserDep > 0 ? ltUserDep : _botDetectedDeposit(d);
  const curPc = _priceChangePnl(d, curDep),
    ltPc = _priceChangePnl(d, ltDep);
  const compounded = d.pnlSnapshot?.totalCompoundedUsd || 0;
  const curCompounded = d.pnlSnapshot?.currentCompoundedUsd || 0;
  const ltGas = d.pnlSnapshot?.totalGas || 0;
  return {
    curTotal: curPc + curFees + curRealized - curCompounded,
    ltTotal: ltPc + ltFees + ltRealized - compounded - ltGas,
    curDep,
    ltDep,
    curRealized,
    ltFees,
    ltRealized,
    ltPriceChange: ltPc,
  };
}
export function _setDepositDisplay(dep) {
  const dd = g("lifetimeDepositDisplay"),
    dl = g("initialDepositLabel");
  if (dd) dd.textContent = dep > 0 ? "$usd " + dep.toFixed(2) : "\u2014";
  if (dl)
    dl.textContent =
      dep > 0 ? "Initial Deposit: $" + dep.toFixed(2) : "Edit Initial Deposit";
}
export function _updateLifetimeKpis(d) {
  if (
    !posStore.getActive() ||
    !d.pnlSnapshot ||
    (d.running && !d.rebalanceScanComplete)
  )
    return;
  const t = _resolveKpiTotals(d);
  _updateNetReturn(
    d,
    t.ltTotal,
    t.ltDep,
    t.ltFees,
    t.ltPriceChange,
    t.ltRealized,
  );
  _setDepositDisplay(t.ltDep);
}
export function _updateKpis(d) {
  if (!posStore.getActive()) return;
  const t = _resolveKpiTotals(d);
  // Current-epoch KPIs: only for managed (unmanaged sets these via quick details)
  if (d.running) {
    _updatePnlHeader(d, t.curTotal, t.curRealized, t.curDep);
    if (d.pnlSnapshot) _applySnapshotKpis(d, t.curDep, t.curRealized);
    else _resetCurrentKpis();
  }
  // Lifetime + deposit: for both managed and unmanaged
  if (d.pnlSnapshot && (!d.running || d.rebalanceScanComplete)) {
    _updateNetReturn(
      d,
      t.ltTotal,
      t.ltDep,
      t.ltFees,
      t.ltPriceChange,
      t.ltRealized,
    );
    _setDepositDisplay(t.ltDep);
  }
  refreshCurDepositDisplay(
    d.hodlBaseline?.entryValue || d.pnlSnapshot?.liveEpoch?.entryValue || 0,
  );
}
export function _updateNetBreakdown(
  bd,
  fees,
  priceChange,
  realized,
  compounded,
  gas,
) {
  if (fees === undefined && priceChange === undefined) {
    bd.textContent = "\u2014";
    return;
  }
  const f = (fees || 0).toFixed(2),
    p = priceChange || 0,
    c = compounded || 0,
    g2 = gas || 0,
    r = (realized || 0).toFixed(2);
  /* Order: Fees − Compounded − Gas + Price Change + Realized */
  let text = f;
  text += " \u2212 " + c.toFixed(2);
  text += " \u2212 " + g2.toFixed(2);
  text += (p >= 0 ? " + " : " \u2212 ") + Math.abs(p).toFixed(2);
  text += " + " + r;
  bd.textContent = text;
}
export function _setProfitKpi(id, fees, gas, ilg, compounded) {
  const el = g(id);
  if (!el) return;
  if (ilg === null || ilg === undefined) {
    _setLeadingText(el, "\u2014");
    el.className = "kpi-value 9mm-pos-mgr-kpi-pct-row neu";
    return;
  }
  const p = (fees || 0) - (gas || 0) + ilg - (compounded || 0);
  _setLeadingText(el, _fmtUsd(p));
  el.className =
    "kpi-value 9mm-pos-mgr-kpi-pct-row " +
    (_isDisplayZero(p) ? "neu" : p > 0 ? "pos" : "neg");
}
export function _ltStartDate(d) {
  return (
    d.pnlSnapshot?.firstEpochDateUtc ||
    d.hodlBaseline?.mintDate ||
    _poolFirstDate
  );
}
export function _updateIL(d, ltDeposit) {
  const il = d.pnlSnapshot
    ? (d.pnlSnapshot.lifetimeIL ?? d.pnlSnapshot.totalIL ?? null)
    : null;
  const ilEl = g("netIL");
  if (!ilEl || !d.pnlSnapshot) return il;
  if (il === null) {
    _setLeadingText(ilEl, "\u2014");
    ilEl.className = "kpi-value 9mm-pos-mgr-kpi-pct-row neu";
  } else {
    _setLeadingText(ilEl, _fmtUsd(il));
    ilEl.className =
      "kpi-value 9mm-pos-mgr-kpi-pct-row " +
      (_isDisplayZero(il) ? "neu" : il > 0 ? "pos" : "neg");
    _setPctSpan("netILPct", il, ltDeposit);
    _setAprSpan("netILApr", il, ltDeposit, _ltStartDate(d));
  }
  return il;
}
export function _updateNetReturn(
  d,
  total,
  ltDeposit,
  ltFees,
  ltPriceChange,
  ltRealized,
) {
  const net = g("kpiNet");
  if (d.pnlSnapshot) {
    _setLeadingText(net, _fmtUsd(total));
    net.className =
      "kpi-value 9mm-pos-mgr-kpi-pct-row " +
      (_isDisplayZero(total) ? "neu" : total > 0 ? "pos" : "neg");
    _setPctSpan("kpiNetPct", total, ltDeposit);
    _setAprSpan("kpiNetApr", total, ltDeposit, _ltStartDate(d));
    const _ll = g("ltPnlLabel"),
      _sd = _ltStartDate(d);
    if (_ll)
      _ll.textContent = _sd
        ? "Net Profit and Loss Return Over " +
          (
            (Date.now() - new Date(_sd + "T00:00:00Z").getTime()) /
            86400000
          ).toFixed(2) +
          " Days"
        : "Net Profit and Loss Return";
    const ltCompounded = d.pnlSnapshot?.totalCompoundedUsd || 0;
    const ltGas2 = d.pnlSnapshot?.totalGas || 0;
    const bd = g("kpiNetBreakdown");
    if (bd)
      _updateNetBreakdown(
        bd,
        ltFees,
        ltPriceChange,
        ltRealized,
        ltCompounded,
        ltGas2,
      );
    const ltVal = g("ltCurrentValue");
    if (ltVal) ltVal.textContent = _fmtUsd(d.pnlSnapshot.currentValue || 0);
  }
  const il = _updateIL(d, ltDeposit);
  const ltComp = d.pnlSnapshot?.totalCompoundedUsd || 0;
  _setProfitKpi("ltProfit", ltFees, d.pnlSnapshot?.totalGas || 0, il, ltComp);
}
export function _missingPriceNames(d) {
  const a = posStore.getActive(),
    n = [];
  if (d.fetchedPrice0 !== undefined && d.fetchedPrice0 <= 0)
    n.push(truncName(a?.token0Symbol || "Token 0", 16));
  if (d.fetchedPrice1 !== undefined && d.fetchedPrice1 <= 0)
    n.push(truncName(a?.token1Symbol || "Token 1", 16));
  return n;
}
function _fillBaselineCtx() {
  const ctx = g("hodlBaselineCtx");
  if (!ctx) return;
  const a = posStore.getActive();
  if (!a) {
    ctx.textContent = "";
    return;
  }
  const pair = (a.token0Symbol || "?") + "/" + (a.token1Symbol || "?");
  const chain = botConfig.chainName || "PulseChain";
  const pm = botConfig.pmName || (a.contractAddress || "").slice(0, 10);
  const w = a.walletAddress
    ? a.walletAddress.slice(0, 6) + "\u2026" + a.walletAddress.slice(-4)
    : "";
  const fee = a.fee ? (a.fee / 10000).toFixed(2) + "% fee" : "";
  const _br = () => ctx.appendChild(document.createElement("br"));
  const _t = (s) => ctx.appendChild(document.createTextNode(s));
  ctx.textContent = "Blockchain: " + chain;
  _br();
  _t("Wallet: " + w);
  _br();
  _t(pair + (pm ? " on " + pm : ""));
  _br();
  _t("NFT #" + a.tokenId + (fee ? " \u00B7 " + fee : ""));
}
export function _showBaselineModal(d, isFallback, isNew, curMissing, missing) {
  const amt = g("hodlBaselineAmt"),
    msg = g("hodlBaselineMsg"),
    date = g("hodlBaselineDate");
  if (!amt) return;
  _fillBaselineCtx();
  if ((isFallback || curMissing) && !isNew) {
    if (msg)
      msg.textContent =
        (missing.length
          ? "Price unavailable for " + missing.join(" and ") + ". "
          : "") + 'Use "Edit" next to Current Value to enter prices manually.';
    amt.textContent = "";
    if (date) date.textContent = "";
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || "\u2014";
  }
  const modal = g("hodlBaselineModal");
  if (modal) modal.className = "modal-overlay";
  const dismiss = () => {
    const bk = _poolKey("9mm_hodl_acked_");
    if (bk) localStorage.setItem(bk, "1");
    if (isFallback) {
      const fk = _poolKey("9mm_hodl_fb_acked_");
      if (fk) localStorage.setItem(fk, "1");
    }
    if (curMissing) {
      const pk = _poolKey("9mm_price_missing_acked_");
      if (pk) sessionStorage.setItem(pk, "1");
    }
    if (modal) modal.className = "modal-overlay hidden";
  };
  const ok = g("hodlBaselineOk");
  if (ok) ok.onclick = dismiss;
  const close = g("hodlBaselineClose");
  if (close) close.onclick = dismiss;
}
function _poolAcked(p) {
  const k = _poolKey(p);
  return k && !!localStorage.getItem(k);
}
export function checkHodlBaselineDialog(d) {
  const fb = d.hodlBaselineFallback && !_poolAcked("9mm_hodl_fb_acked_");
  const isNew =
    d.hodlBaselineNew && d.hodlBaseline && !_poolAcked("9mm_hodl_acked_");
  const missing = _missingPriceNames(d);
  const pmk = _poolKey("9mm_price_missing_acked_");
  const cm = missing.length > 0 && !(pmk && sessionStorage.getItem(pmk));
  if (fb || isNew || cm) _showBaselineModal(d, fb, isNew, cm, missing);
}
export {
  _activeToken1Symbol,
  positionRangeVisual,
  updateRangePctLabels,
} from "./dashboard-data-range.js";
