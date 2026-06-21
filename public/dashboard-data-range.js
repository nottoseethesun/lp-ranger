/**
 * @file dashboard-data-range.js
 * @description Position range visual rendering: range bar, handles, price
 * marker, threshold preview lines, and range percentage labels.
 * Split from dashboard-data-kpi.js.
 */
import {
  g,
  botConfig,
  truncName,
  fmtNum,
  isFullRange,
} from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";

/** Return the truncated token1 symbol for the active position. */
export function _activeToken1Symbol() {
  const a = posStore.getActive();
  return truncName(a ? a.token1Symbol || "?" : "?", 12);
}

function _showFullRange() {
  const s = _activeToken1Symbol(),
    _h = (id) => {
      const e = g(id);
      if (e) e.style.display = "none";
    };
  const ra = g("rangeActive");
  if (ra) {
    ra.style.left = "2%";
    ra.style.width = "96%";
  }
  _h("hl");
  _h("hr");
  _h("rangeLnL");
  _h("rangeLnR");
  _h("rangeStartLabel");
  _h("rangeEndLabel");
  _h("rlL");
  _h("rlR");
  const rv = document.querySelector(".range-visual");
  if (rv) {
    rv.style.overflow = "visible";
    rv.style.marginBottom = "0";
  }
  const fr = g("fullRangeLabels");
  if (fr) fr.hidden = false;
  const pm = g("pm");
  if (pm && botConfig.price > 0) {
    pm.style.left = "50%";
    pm.style.visibility = "visible";
  }
  const pml = g("pmlabel");
  if (pml) {
    pml.textContent = fmtNum(botConfig.price) + " " + s;
    pml.title = String(botConfig.price);
  }
  ["rangePctLower", "rangePctUpper"].forEach((id) => {
    const e = g(id);
    if (e) e.textContent = "Full range";
  });
}

/** Position range bar, handles, price marker. */
export function positionRangeVisual() {
  const lo = botConfig.lower,
    hi = botConfig.upper;
  if (!lo || !hi || lo >= hi) return;
  if (isFullRange(lo, hi)) {
    _showFullRange();
    return;
  }
  ["hl", "hr", "rangeLnL", "rangeLnR", "rlL", "rlR"].forEach((id) => {
    const e = g(id);
    if (e) {
      e.style.display = "";
      e.style.visibility = "";
      e.style.transform = "";
    }
  });
  ["rangeStartLabel", "rangeEndLabel", "fullRangeLabels"].forEach((id) => {
    const e = g(id);
    if (e) {
      e.style.display = "none";
      if (e.hidden !== undefined) e.hidden = true;
    }
  });
  const _rv = document.querySelector(".range-visual");
  if (_rv) {
    _rv.style.overflow = "";
    _rv.style.marginBottom = "";
  }
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  the shipped default for `rebalanceOutOfRangeThresholdPercent` lives
   *  only in bot-config-defaults.json.  If the AJAX-populated value
   *  hasn't arrived yet, skip the threshold-preview lines — the rest
   *  of the bar still renders. */
  if (botConfig.oorThreshold === undefined) return;
  const threshPct = botConfig.oorThreshold / 100;
  const rangeSpan = hi - lo;
  const previewLo = lo - rangeSpan * threshPct;
  const previewHi = hi + rangeSpan * threshPct;
  const pad = rangeSpan * Math.max(0.6, threshPct * 1.5);
  const vMin = Math.max(0, lo - pad),
    vMax = hi + pad,
    vSpan = vMax - vMin;
  const pct = (p) => (((p - vMin) / vSpan) * 100).toFixed(2) + "%";
  const ra = g("rangeActive");
  if (ra) {
    ra.style.left = pct(lo);
    ra.style.width = (((hi - lo) / vSpan) * 100).toFixed(2) + "%";
  }
  const hl = g("hl"),
    hr = g("hr");
  if (hl) hl.style.left = pct(lo);
  if (hr) hr.style.left = pct(hi);
  const rsym = _activeToken1Symbol(),
    rlL = g("rlL"),
    rlR = g("rlR");
  if (rlL) {
    rlL.style.left = pct(lo);
    rlL.textContent = fmtNum(lo) + " " + rsym;
    rlL.title = lo.toString() + " " + rsym;
  }
  if (rlR) {
    rlR.style.left = pct(hi);
    rlR.textContent = fmtNum(hi) + " " + rsym;
    rlR.title = hi.toString() + " " + rsym;
  }
  const pm = g("pm");
  if (pm && botConfig.price > 0) {
    pm.style.left = pct(botConfig.price);
    pm.style.visibility = "visible";
  }
  const lnL = g("rangeLnL"),
    lnR = g("rangeLnR"),
    rsym2 = _activeToken1Symbol();
  if (lnL) {
    lnL.style.left = pct(previewLo);
    lnL.title =
      "Rebalance trigger: " +
      fmtNum(previewLo) +
      " " +
      rsym2 +
      " (" +
      botConfig.oorThreshold +
      "% below lower)";
  }
  if (lnR) {
    lnR.style.left = pct(previewHi);
    lnR.title =
      "Rebalance trigger: " +
      fmtNum(previewHi) +
      " " +
      rsym2 +
      " (" +
      botConfig.oorThreshold +
      "% above upper)";
  }
}

/** Update the range percentage labels below the visual bar. */
export function updateRangePctLabels(price, lower, upper) {
  const lo = g("rangePctLower"),
    hi = g("rangePctUpper");
  if (!lo || !hi || !price || price <= 0) return;
  if (isFullRange(lower, upper)) {
    lo.textContent = "Full range";
    hi.textContent = "Full range";
    return;
  }
  const loPct = ((lower - price) / price) * 100,
    hiPct = ((upper - price) / price) * 100;
  lo.textContent = loPct.toFixed(3) + "% below price";
  lo.title = loPct.toString() + "%";
  hi.textContent = "+" + hiPct.toFixed(3) + "% above price";
  hi.title = "+" + hiPct.toString() + "%";
}
