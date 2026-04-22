/**
 * @file dashboard-unmanaged-apply.js
 * @description DOM-update helpers for the unmanaged-position detail flow.
 *   Extracted from dashboard-unmanaged.js for line-count compliance.
 *   These functions populate the dashboard panels from API response data.
 */

import {
  g,
  botConfig,
  truncName,
  fmtNum,
  fmtDateTime,
} from "./dashboard-helpers.js";
import {
  positionRangeVisual,
  updateRangePctLabels,
  setKpiValue,
  checkHodlBaselineDialog,
} from "./dashboard-data.js";
import {
  setLastPrices,
  clearPriceOverrideIfFetched,
} from "./dashboard-price-override.js";
import { updateILDebugData } from "./dashboard-il-debug.js";
import { renderDailyPnl, renderRebalanceEvents } from "./dashboard-history.js";
import { posStore } from "./dashboard-positions.js";

/** Update the composition bar + labels, or show grey "no price data" state. */
export function _applyComposition(d, pos) {
  const tn0 = truncName(pos.token0Symbol || "?", 12),
    tn1 = truncName(pos.token1Symbol || "?", 12);
  const c0 = g("c0"),
    c1 = g("c1"),
    cl0 = g("cl0"),
    cl1 = g("cl1");
  if (d.composition === null) {
    if (c0) {
      c0.style.width = "50%";
      c0.style.background = "#555";
    }
    if (c1) {
      c1.style.width = "50%";
      c1.style.background = "#555";
    }
    if (cl0) cl0.textContent = tn0 + ": no price data";
    if (cl1) cl1.textContent = tn1 + ": no price data";
  } else {
    const r0 = d.composition;
    if (c0) {
      c0.style.width = (r0 * 100).toFixed(1) + "%";
      c0.style.background = "";
    }
    if (c1) {
      c1.style.width = ((1 - r0) * 100).toFixed(1) + "%";
      c1.style.background = "";
    }
    if (cl0)
      cl0.textContent = "\u25A0 " + tn0 + ": " + (r0 * 100).toFixed(0) + "%";
    if (cl1)
      cl1.textContent =
        "\u25A0 " + tn1 + ": " + ((1 - r0) * 100).toFixed(0) + "%";
  }
}

/** Update the lifetime date range label and duration. */
export function _applyLifetimeDates(d) {
  const startDate = d.firstEpochDate || d.mintDate;
  const sub = g("kpiPnlPct");
  if (sub)
    sub.textContent = startDate
      ? startDate + " \u2192 " + new Date().toISOString().slice(0, 10)
      : "";
  if (startDate) {
    const days = (
      (Date.now() - new Date(startDate).getTime()) /
      86400000
    ).toFixed(2);
    const ltLabel = g("ltPnlLabel");
    if (ltLabel)
      ltLabel.textContent = "Net Profit and Loss Return over " + days + " days";
  }
}

/** Adjust a lifetime KPI by subtracting compounded fees (avoids double-counting). */
function _adjCompounded(raw, fallback, compounded) {
  return raw !== undefined ? raw - (compounded || 0) : fallback;
}

/** Build positionStats payload for IL debug popover from unmanaged details. */
function _balanceStats(amounts) {
  if (!amounts) return undefined;
  return {
    balance0: amounts.amount0.toFixed(6),
    balance1: amounts.amount1.toFixed(6),
  };
}

/** Populate the Lifetime panel from phase-2 response. */
export function _applyLifetime(d) {
  const comp = d.ltCompounded || 0;
  setKpiValue("kpiNet", _adjCompounded(d.ltNetPnl, d.netPnl, comp));
  setKpiValue("ltProfit", _adjCompounded(d.ltProfit, d.profit, comp));
  if (d.il !== null && d.il !== undefined) setKpiValue("netIL", d.il);
  console.log(
    "%c[lp-ranger] [unmanaged] lifetime entryValue=%s",
    "color:#fa0",
    d.entryValue,
  );
  const ltDep = g("lifetimeDepositDisplay");
  if (ltDep && d.entryValue > 0)
    ltDep.textContent = "$usd " + d.entryValue.toFixed(2);
  const bd = g("kpiNetBreakdown");
  if (bd && d.ltFees !== undefined) {
    const f = (d.ltFees || 0).toFixed(2),
      c = (d.ltCompounded || 0).toFixed(2),
      g2 = (d.ltGas || 0).toFixed(2),
      pc = d.ltPriceChange || 0,
      r = "0.00";
    /* Order: Fees − Compounded − Gas + Price Change + Realized */
    bd.textContent =
      f +
      " \u2212 " +
      c +
      " \u2212 " +
      g2 +
      (pc >= 0 ? " + " : " \u2212 ") +
      Math.abs(pc).toFixed(2) +
      " + " +
      r;
  }
  _applyLifetimeDates(d);
  if (d.dailyPnl) renderDailyPnl(d.dailyPnl);
  if (d.rebalanceEvents) renderRebalanceEvents(d.rebalanceEvents);
  // Update IL debug popover with lifetime HODL amounts from phase 2
  if (d.pnlSnapshot?.ilInputs)
    updateILDebugData({
      pnlSnapshot: d.pnlSnapshot,
      positionStats: _balanceStats(d.amounts),
    });
}

/** Apply balances, pool share, and tick to the position stats panel. */
export function _applyPositionStats(d) {
  const sw = g("sWpls");
  if (sw) sw.textContent = d.amounts.amount0.toFixed(4);
  const su = g("sUsdc");
  if (su) su.textContent = d.amounts.amount1.toFixed(4);
  const s0 = g("sShare0"),
    s1 = g("sShare1");
  if (s0)
    s0.textContent =
      d.poolShare0Pct !== undefined
        ? "Pool Share: " + d.poolShare0Pct.toFixed(4) + "% "
        : "\u2014";
  if (s1)
    s1.textContent =
      d.poolShare1Pct !== undefined
        ? "Pool Share: " + d.poolShare1Pct.toFixed(4) + "% "
        : "\u2014";
  const tc = g("sTC");
  if (tc && d.poolState.tick !== undefined) tc.textContent = d.poolState.tick;
  _applyUnmanagedResiduals(d);
}

/*- Populate the Residual fields + tooltips for the unmanaged (one-shot)
 *  detail flow. Server returns residualAmount0/1 + residualUsd0/1 at the
 *  top level of the quick-details payload. Tooltip includes an extra
 *  note that the position is unmanaged so residuals are wallet-balance
 *  snapshots (not bot-tracked over time). */
function _applyUnmanagedResiduals(d) {
  const r0 = g("sResidual0"),
    r1 = g("sResidual1");
  const fmt = (v) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(3) : "\u2014";
  if (r0) r0.textContent = fmt(d.residualAmount0);
  if (r1) r1.textContent = fmt(d.residualAmount1);
  const tip0 = g("sResidual0Tip"),
    tip1 = g("sResidual1Tip");
  const usdFmt = (v) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(2) : "0.00";
  const note =
    " (Unmanaged position: this is a current wallet-balance snapshot," +
    " not tracked over time. Click Manage to enable bot-tracked residuals.)";
  if (tip0)
    tip0.textContent =
      `Coins left liquid on the wallet; ~ $usd ${usdFmt(d.residualUsd0)}.` +
      note;
  if (tip1)
    tip1.textContent =
      `Coins left liquid on the wallet; ~ $usd ${usdFmt(d.residualUsd1)}.` +
      note;
}

/** Apply current-panel KPIs from phase-1 data. */
export function _applyCurrentKpis(d) {
  setKpiValue("kpiValue", d.value);
  const ltVal = g("ltCurrentValue");
  if (ltVal) setKpiValue("ltCurrentValue", d.value);
  setKpiValue("pnlFees", d.feesUsd);
  setKpiValue("pnlPrice", d.priceGainLoss);
  console.log(
    "%c[lp-ranger] [unmanaged] phase1 entryValue=%s baseline=%s",
    "color:#fa0",
    d.entryValue,
    d.baselineEntryValue,
  );
  setKpiValue("kpiPnl", d.netPnl);
  setKpiValue("curProfit", d.profit);
  setKpiValue("curIL", d.il);
  setKpiValue("pnlRealized", 0);
}

/** Position age + mint date. */
function _applyPosDuration(d) {
  if (!d.mintTimestamp) return;
  const dur = g("kpiPosDuration");
  if (!dur) return;
  const ms = Date.now() - d.mintTimestamp * 1000;
  const dd = Math.floor(ms / 86400000),
    hh = Math.floor((ms % 86400000) / 3600000),
    mm = Math.floor((ms % 3600000) / 60000);
  dur.textContent =
    "Active: " +
    dd +
    "d " +
    hh +
    "h " +
    mm +
    "m \u00B7 Minted: " +
    fmtDateTime(new Date(d.mintTimestamp * 1000));
}

/** IL debug data for "i" buttons. */
function _applyILDebug(d) {
  if (d.il === null || d.il === undefined || d.hodlAmount0 === null) return;
  const hodl = { hodlAmount0: d.hodlAmount0, hodlAmount1: d.hodlAmount1 };
  updateILDebugData(
    {
      pnlSnapshot: {
        totalIL: d.il,
        lifetimeIL: d.il,
        ilInputs: {
          lpValue: d.value,
          price0: d.price0,
          price1: d.price1,
          cur: hodl,
          lt: hodl,
        },
      },
      positionStats: _balanceStats(d.amounts),
    },
    posStore,
  );
}

/** Apply phase-1 (fast) position details to the dashboard UI. */
export function _apply(d, pos) {
  // Range chart + price marker
  botConfig.price = d.poolState.price;
  pos.poolAddress = d.poolState.poolAddress || null;
  botConfig.lower = d.lowerPrice;
  botConfig.upper = d.upperPrice;
  botConfig.tL = pos.tickLower;
  botConfig.tU = pos.tickUpper;
  const sym = truncName(pos.token1Symbol || "?", 12);
  const pml = g("pmlabel");
  if (pml) {
    pml.textContent = fmtNum(d.poolState.price) + " " + sym;
    pml.title = String(d.poolState.price);
  }
  positionRangeVisual();
  updateRangePctLabels(d.poolState.price, d.lowerPrice, d.upperPrice);
  // ACTIVE/CLOSED badge
  const closed = pos.liquidity !== undefined && String(pos.liquidity) === "0";
  const badge = g("curPosStatus");
  if (badge) {
    badge.textContent = closed ? "CLOSED" : "ACTIVE";
    badge.className =
      "9mm-pos-mgr-pos-status " + (closed ? "closed" : "active");
  }
  console.log(
    "%c[lp-ranger] [unmanaged] prices: p0=%s p1=%s fetched0=%s fetched1=%s",
    "color:#fa0",
    d.price0,
    d.price1,
    d.fetchedPrice0,
    d.fetchedPrice1,
  );
  setLastPrices(d.price0, d.price1);
  clearPriceOverrideIfFetched(d.fetchedPrice0 || 0, d.fetchedPrice1 || 0);
  _applyCurrentKpis(d);
  _applyPosDuration(d);
  // Single-epoch lifetime (overwritten by phase 2 when it returns)
  _applyLifetime(d);
  _applyILDebug(d);
  _applyComposition(d, pos);
  _applyPositionStats(d);
  checkHodlBaselineDialog(d);
}
