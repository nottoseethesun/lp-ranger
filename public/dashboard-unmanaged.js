/**
 * @file dashboard-unmanaged.js
 * @description One-shot detail fetch for unmanaged LP positions.
 *   When the user views an unmanaged position, this module fetches live
 *   pool state, token prices, composition, and value from the server
 *   and populates the dashboard KPIs using shared rendering functions.
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
  resetKpis,
  checkHodlBaselineDialog,
  pollNow,
} from "./dashboard-data.js";
import {
  loadPriceOverrides,
  loadForceOverride,
  setLastPrices,
  clearPriceOverrideIfFetched,
} from "./dashboard-price-override.js";
import { updateILDebugData } from "./dashboard-il-debug.js";
import { renderDailyPnl, renderRebalanceEvents } from "./dashboard-history.js";
import { posStore } from "./dashboard-positions.js";
import { enterClosedPosView } from "./dashboard-closed-pos.js";
import { isWalletUnlocked } from "./dashboard-wallet.js";

const _ALL_KPIS = [
  "kpiValue",
  "pnlFees",
  "pnlPrice",
  "kpiPnl",
  "curProfit",
  "curIL",
  "pnlRealized",
  "kpiNet",
  "ltProfit",
  "netIL",
  "kpiNetBreakdown",
  "kpiPosDuration",
  "ltCurrentValue",
];

/** Update the composition bar + labels, or show grey "no price data" state. */
function _applyComposition(d, pos) {
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
function _applyLifetimeDates(d) {
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

/** Populate the Lifetime panel from phase-2 response. */
function _applyLifetime(d) {
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
}

/** Apply balances, pool share, and tick to the position stats panel. */
function _applyPositionStats(d) {
  const sw = g("sWpls");
  if (sw) sw.textContent = d.amounts.amount0.toFixed(4);
  const su = g("sUsdc");
  if (su) su.textContent = d.amounts.amount1.toFixed(4);
  const s0 = g("sShare0"),
    s1 = g("sShare1");
  if (s0)
    s0.textContent =
      d.poolShare0Pct !== undefined
        ? d.poolShare0Pct.toFixed(4) + "%"
        : "\u2014";
  if (s1)
    s1.textContent =
      d.poolShare1Pct !== undefined
        ? d.poolShare1Pct.toFixed(4) + "%"
        : "\u2014";
  const tc = g("sTC");
  if (tc && d.poolState.tick !== undefined) tc.textContent = d.poolState.tick;
}

/** Apply current-panel KPIs from phase-1 data. */
function _applyCurrentKpis(d) {
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

/** Apply phase-1 (fast) position details to the dashboard UI. */
function _apply(d, pos) {
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
  // Position age + mint date
  if (d.mintTimestamp) {
    const dur = g("kpiPosDuration");
    if (dur) {
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
  }
  // Single-epoch lifetime (overwritten by phase 2 when it returns)
  _applyLifetime(d);
  // IL debug data for "i" buttons
  if (d.il !== null && d.il !== undefined && d.hodlAmount0 !== null) {
    const hodl = {
      hodlAmount0: d.hodlAmount0,
      hodlAmount1: d.hodlAmount1,
    };
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
      },
      posStore,
    );
  }
  _applyComposition(d, pos);
  _applyPositionStats(d);
  checkHodlBaselineDialog(d);
}

/** Build the request body for position detail endpoints. */
function _detailBody(pos) {
  return {
    tokenId: pos.tokenId,
    token0: pos.token0,
    token1: pos.token1,
    fee: pos.fee,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: String(pos.liquidity || 0),
    walletAddress: pos.walletAddress,
    contractAddress: pos.contractAddress,
    ...(() => {
      const ov = loadPriceOverrides(),
        r = {};
      if (ov.price0 > 0) r.priceOverride0 = ov.price0;
      if (ov.price1 > 0) r.priceOverride1 = ov.price1;
      if (loadForceOverride()) r.priceOverrideForce = true;
      return r;
    })(),
  };
}

let _lastFetchedId = null,
  _fetchGen = 0;

/** Reset the dedup guard so the next fetchUnmanagedDetails call will re-fetch. */
export function resetLastFetchedId() {
  _lastFetchedId = null;
}

/**
 * Check if the server response indicates a fully drained (closed) position.
 * Both token amounts and USD value must be zero.
 * @param {object} d  Phase-1 API response.
 * @returns {boolean}
 */
function _isResponseDrained(d) {
  return (
    d.amounts &&
    d.amounts.amount0 === 0 &&
    d.amounts.amount1 === 0 &&
    d.value === 0
  );
}

/**
 * Run phase-1 (fast) detail fetch.  If the server reveals the position was
 * fully drained, updates posStore and switches to the closed-pos history view.
 * @param {object} pos   posStore entry.
 * @param {object} body  Request body (mutated: feesUsd added on success).
 * @returns {Promise<boolean>}  True if switched to closed-pos view.
 */
async function _phase1(pos, body) {
  try {
    const r = await fetch("/api/position/details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) {
      console.warn("[lp-ranger] [unmanaged] details error:", d.error);
      return false;
    }
    if (_isResponseDrained(d)) {
      pos.liquidity = "0";
      enterClosedPosView(pos);
      return true;
    }
    _apply(d, pos);
    body.feesUsd = d.feesUsd;
  } catch (e) {
    console.warn("[lp-ranger] [unmanaged] phase 1 failed:", e.message);
  }
  return false;
}

/** Trigger an immediate poll so the badge updates from server state.
 *  The server writes rebalanceScanComplete when the lifetime scan
 *  finishes (same path for managed and unmanaged) — no client flag. */
function _markSynced() {
  pollNow();
}

/** Phase 2: slow — lifetime P&L (event scan + epoch reconstruction). */
async function _phase2(body, gen) {
  try {
    const r2 = await fetch("/api/position/lifetime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (gen !== _fetchGen) return;
    const d2 = await r2.json();
    if (d2.ok) _applyLifetime(d2);
  } catch (e) {
    console.warn("[lp-ranger] [unmanaged] phase 2 failed:", e.message);
  }
  if (gen === _fetchGen) _markSynced();
}

/** Fetch and display details for an unmanaged position (two-phase). */
export async function fetchUnmanagedDetails(pos) {
  if (!pos?.tokenId || !pos?.token0 || !pos?.token1 || !pos?.fee) return;
  // Defer until wallet is unlocked — API keys (Moralis etc.) need the password.
  if (!isWalletUnlocked()) return;
  const tid = String(pos.tokenId);
  if (tid === _lastFetchedId) return;
  _lastFetchedId = tid;
  const gen = ++_fetchGen;
  resetKpis(_ALL_KPIS);
  const sub = g("kpiPnlPct");
  if (sub) sub.textContent = "";
  const badge = g("syncBadge");
  if (badge) {
    badge.textContent = "Syncing\u2026";
    badge.classList.remove("done");
    badge.style.background = "";
  }
  const body = _detailBody(pos);
  // Phase 1: fast — pool state, value, composition, current P&L.
  // If the position turns out to be closed (fully drained), phase 1
  // switches to the closed-pos history view and skips phase 2.
  if (await _phase1(pos, body)) {
    if (gen === _fetchGen) _markSynced();
    return;
  }
  if (gen !== _fetchGen) return;
  await _phase2(body, gen);
}
