/**
 * @file dashboard-data-kpi.js — KPI calculation and display.
 *
 * Deposit Resolution: Both panels have user-editable deposit fields
 * persisted to localStorage (per-position for Current, per-pool for
 * Lifetime) + synced to .bot-config.json.  User values always win.
 *
 * Lifetime Deposit Fallback Chain (_resolveLifetimeDeposit):
 *  ● Scan total (totalLifetimeDeposit) — Lifetime panel only, never
 *    Current.  HODL scan sums fresh deposits at historical prices.
 *  ● First closed epoch entry (closedEpochs[0].entryValue) — original
 *    position's value when the bot first started tracking.
 *  ● Current baseline (hodlBaseline.entryValue) — current NFT's entry
 *    value at most recent rebalance.  Always available but not the
 *    original deposit.
 */
import { _fmtUsd as _fmtUsdImpl } from "./dashboard-fmt-usd.js";
import { g, fmtDateTime, fmtDuration } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import { updateNetBreakdown as _updateNetBreakdown } from "./dashboard-data-kpi-breakdown.js";
import {
  loadRealizedGains,
  loadCurRealized,
  loadInitialDeposit,
  loadCurDeposit,
  refreshCurDepositDisplay,
} from "./dashboard-data-deposit.js";
import { setLeadingText } from "./dashboard-kpi-dom.js";
import { ltStartDate, toMintTsSeconds } from "./dashboard-date-utils.js";

/** Cached P&L breakdowns for the info dialogs.
 *  `currentFees` is the live unclaimed-fee figure (snap.currentFeesUsd);
 *  `compounded` is the historical lifetime-compounded total.  Both are
 *  surfaced additively in the new Net P&L math (no more "Lifetime Fees"
 *  row that mixed the two with the imprecise per-epoch tracker total). */
const _ltBreakdown = {
  currentFees: 0,
  compounded: 0,
  gas: 0,
  priceChange: 0,
  residual: 0,
  realized: 0,
  total: 0,
  currentValue: 0,
  deposit: 0,
};
const _curBreakdown = {
  fees: 0,
  compounded: 0,
  gas: 0,
  priceChange: 0,
  residual: 0,
  realized: 0,
  total: 0,
  currentValue: 0,
  deposit: 0,
};
/** @returns {typeof _ltBreakdown} */
export function getLtBreakdown() {
  return _ltBreakdown;
}
/** @returns {typeof _curBreakdown} */
export function getCurBreakdown() {
  return _curBreakdown;
}

/*- Re-exported from dashboard-fmt-usd.js so existing importers of this
 *  module's `_fmtUsd` keep working. */
export const _fmtUsd = _fmtUsdImpl;
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
  const sec = firstDate
    ? (Date.now() - new Date(firstDate + "T00:00:00Z").getTime()) / 1000
    : 0;
  if (!deposit || deposit <= 0 || sec <= 0) {
    el.textContent = "\u2014";
    return;
  }
  const apr = (val / deposit / (sec / (365.25 * 86400))) * 100;
  if (Math.abs(apr) < 0.005) {
    el.textContent = "APR 0.00%";
    el.style.color = "";
    return;
  }
  const sign = apr > 0 ? "APR " : "APR \u2212";
  el.textContent = sign + Math.abs(apr).toFixed(2) + "%";
  el.style.color = apr > 0 ? "#0f0" : "#f44";
}
export const _setLeadingText = setLeadingText;
export function resetKpis(ids) {
  for (const id of ids) {
    const el = g(id);
    if (!el) continue;
    _setLeadingText(el, "\u2014");
    // Preserve layout classes (e.g. 9mm-pos-mgr-kpi-pct-row) — only swap
    // the pos/neg/neu modifier.  Overwriting el.className drops the flex
    // layout class that spreads the trailing %/APR spans across the row.
    el.classList.remove("pos", "neg");
    el.classList.add("kpi-value", "neu");
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
export function setKpiValue(id, val, forceClass) {
  const el = g(id);
  if (!el) return;
  // Preserve layout classes (e.g. 9mm-pos-mgr-kpi-pct-row) — only swap the
  // pos/neg/neu modifier. Overwriting el.className drops the flex layout
  // class that aligns the trailing %/APR spans across the row.
  if (val === null || val === undefined) {
    _setLeadingText(el, "\u2014");
    el.classList.remove("pos", "neg");
    el.classList.add("kpi-value", "neu");
    return;
  }
  const cls =
    forceClass || (_isDisplayZero(val) ? "neu" : val > 0 ? "pos" : "neg");
  _setLeadingText(el, _fmtUsd(val));
  el.classList.remove("pos", "neg", "neu");
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
  /*- Try numeric/ISO mint timestamps first via toMintTsSeconds; fall back
      to the YYYY-MM-DD mintDate for older positions that have no exact
      mint timestamp.  Both Unix-seconds and ISO-string shapes appear in
      live .bot-config.json files (see dashboard-date-utils.js). */
  const mtRaw = d.positionMintTimestamp || d.hodlBaseline?.mintTimestamp;
  let ms;
  let label;
  const ts = toMintTsSeconds(mtRaw);
  if (ts) {
    ms = Date.now() - ts * 1000;
    label = ts * 1000;
  } else if (d.hodlBaseline?.mintDate) {
    ms =
      Date.now() - new Date(d.hodlBaseline.mintDate + "T00:00:00Z").getTime();
    label = d.hodlBaseline.mintDate;
  } else {
    el.textContent = "\u2014";
    return;
  }
  el.textContent =
    ms > 0
      ? "Active: " + fmtDuration(ms) + " \u00B7 Minted: " + fmtDateTime(label)
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
  const curGas = ep ? ep.gas || 0 : 0;
  _renderPnlGas(curGas);
  const curPc = deposit > 0 ? cv - deposit : 0;
  setKpiValue("pnlPrice", curPc);
  setKpiValue("pnlRealized", curRealized);
  Object.assign(_curBreakdown, {
    fees: curFees,
    compounded: curCompounded,
    gas: curGas,
    priceChange: curPc,
    realized: curRealized,
    total: curPc + curFees + curRealized - curCompounded,
    currentValue: cv,
    deposit,
  });
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
  return d.initialDepositUsd > 0
    ? d.initialDepositUsd
    : d.hodlBaseline?.entryValue > 0
      ? d.hodlBaseline.entryValue
      : d.pnlSnapshot?.initialDeposit || 0;
}
/** Resolve lifetime deposit: user → scan total → first epoch → baseline. */
export function _resolveLifetimeDeposit(d) {
  const user = loadInitialDeposit();
  if (user > 0) return user; // manual override
  return (
    d.pnlSnapshot?.totalLifetimeDeposit || // scan total
    d.pnlSnapshot?.closedEpochs?.[0]?.entryValue || // first epoch
    _botDetectedDeposit(d)
  ); // current baseline
}
export function _resolveCurDeposit(d) {
  const saved = loadCurDeposit();
  if (saved > 0) return saved;
  const bl = d.hodlBaseline?.entryValue || 0;
  return d._hasPositionData
    ? bl > 0
      ? bl
      : d.pnlSnapshot?.liveEpoch?.entryValue || 0
    : 0;
}
export function _priceChangePnl(d, deposit) {
  if (!d.pnlSnapshot || deposit <= 0) return 0;
  // currentValue is LP-only; residuals are tracked separately and roll into
  // lifetime deposit on the next rebalance, so they don't belong here.
  const cv = d.pnlSnapshot.currentValue || 0;
  return cv - deposit;
}
export function _resolveKpiTotals(d) {
  const ltRealized = loadRealizedGains(),
    curRealized = loadCurRealized();
  /*- New lifetime-fee model: `lifetimeCompounded + currentFees`.  The old
   *  `snap.totalFees` was the per-epoch tracker sum which only saw
   *  bot-uptime fees and missed fees folded into rebalances — for
   *  HEX/eHEX it was off by $100+, only ~1/3 of the on-chain figure.
   *  The historical Σ(Collect)−Σ(DL) scan + currently-unclaimed reading
   *  gives us the precise total. */
  const curFees = d.pnlSnapshot?.liveEpoch?.fees || 0;
  const ltCurrentFees = d.pnlSnapshot?.currentFeesUsd ?? curFees;
  const curDep = _resolveCurDeposit(d);
  const ltDep = _resolveLifetimeDeposit(d);
  const curPc = _priceChangePnl(d, curDep),
    ltPc = _priceChangePnl(d, ltDep);
  const compounded = d.pnlSnapshot?.totalCompoundedUsd || 0;
  const curCompounded = d.pnlSnapshot?.currentCompoundedUsd || 0;
  const ltGas = d.pnlSnapshot?.totalGas || 0;
  /*- Wallet residual (pool tokens sitting in the wallet from prior
   *  rebalances) is LP-adjacent value the user still holds.  Without it,
   *  between-rebalance Lifetime totals overstate loss: Price Change drops
   *  when an NFT is drained but the resulting wallet balance isn't
   *  offsetting it until the next mint folds it back into entry value.
   *  Adding it here closes that visual gap without double-counting —
   *  Price Change is LP-only by design (see _priceChangePnl). */
  const ltResidual = d.pnlSnapshot?.residualValueUsd || 0;
  /*- Initial Wallet Residual (Pool): the wallet's token0/token1 balances at
   *  the END of `firstMintBlock` — what was left over after the very first
   *  IncreaseLiquidity TX consumed its inputs — valued at FROZEN first-mint
   *  prices. Subtracted from Lifetime Net P&L so the unavoidable leftover
   *  from the initial mint does not inflate profit. Frozen valuation
   *  preserves credit for any subsequent appreciation of those tokens. */
  const ltInitialResidual = d.pnlSnapshot?.initialResidualUsd || 0;
  return {
    curTotal: curPc + curFees + curRealized - curCompounded,
    /*- Lifetime total folds in fee earnings additively: compounded fees
     *  (already realized, swept back into liquidity) plus currently
     *  unclaimed fees (will be compounded next).  No subtraction term
     *  for compounded — it IS the fee earnings figure. */
    ltTotal:
      ltPc +
      compounded +
      ltCurrentFees +
      ltRealized -
      ltGas +
      ltResidual -
      ltInitialResidual,
    curDep,
    ltDep,
    curRealized,
    ltCurrentFees,
    ltRealized,
    ltPriceChange: ltPc,
    ltResidual,
    ltInitialResidual,
  };
}
export function _setDepositDisplay(dep, totalLifetimeDep, usedFallback) {
  const v = totalLifetimeDep > 0 ? totalLifetimeDep : dep;
  const dd = g("lifetimeDepositDisplay");
  if (dd) dd.textContent = v > 0 ? _fmtUsd(v) : "\u2014";
  const dl = g("initialDepositLabel");
  if (dl) dl.textContent = "Edit Total Lifetime Deposit for This Pool";
  const popover = g("ltDepositPriceInfoText");
  if (popover && v > 0) {
    // User-entered shows only when scan total didn't override (display logic
    // prefers totalLifetimeDep when > 0). Saving the field as empty (0) reverts
    // to auto-detection on the next refresh.
    const userVal = loadInitialDeposit();
    if (userVal > 0 && !(totalLifetimeDep > 0))
      popover.textContent =
        "Manually entered value. To revert to auto-detection, edit and save the field as empty (0).";
    else if (totalLifetimeDep > 0)
      popover.textContent = usedFallback
        ? "Valued using Current Price (historical price unavailable). Re-start the app to try again to fetch historical prices."
        : "Valued using Historical Price at the time of each deposit.";
  }
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
    t.ltCurrentFees,
    t.ltPriceChange,
    t.ltRealized,
    t.ltResidual,
    t.ltInitialResidual,
  );
  _setDepositDisplay(
    t.ltDep,
    d.pnlSnapshot?.totalLifetimeDeposit,
    d.pnlSnapshot?.depositUsedFallback,
  );
}
/*- Render Current-panel Gas with the dust-friendly "< $0.01" label
 *  for sub-cent values. Shared by managed (_applySnapshotKpis) and
 *  unmanaged (_applyUnmanagedSnapshotOverlay). */
function _renderPnlGas(curGas) {
  if (curGas > 0 && curGas < 0.01) {
    const el = g("pnlGas");
    if (el) {
      el.textContent = "< $0.01";
      el.className = el.className.replace(/\b(pos|neg|neu)\b/g, "").trim();
      el.classList.add("neg");
    }
    return;
  }
  setKpiValue("pnlGas", curGas > 0 ? curGas : null, "neg");
}

/*- Unmanaged: phase 1 (_applyCurrentKpis) populates value/fees/price
 *  but doesn't touch Fees Compounded or Gas — those come from the
 *  per-NFT chain scan in phase 2 and would otherwise render as dash.
 *  Both currentCompoundedUsd and currentGasUsd are computed by the
 *  unmanaged scan from chain (mint TX + standalone compound TXs at
 *  current native price), independent of any prior Manage cycle. */
function _applyUnmanagedSnapshotOverlay(d) {
  if (!d.pnlSnapshot) return;
  const curComp = d.pnlSnapshot.currentCompoundedUsd || 0;
  setKpiValue("pnlCompounded", curComp > 0 ? curComp : null);
  _renderPnlGas(d.pnlSnapshot.currentGasUsd || 0);
}

export function _updateKpis(d) {
  if (!posStore.getActive()) return;
  const t = _resolveKpiTotals(d);
  // Current-epoch KPIs: only for managed (unmanaged sets these via quick details)
  if (d.running) {
    _updatePnlHeader(d, t.curTotal, t.curRealized, t.curDep);
    if (d.pnlSnapshot) _applySnapshotKpis(d, t.curDep, t.curRealized);
    else _resetCurrentKpis();
  } else _applyUnmanagedSnapshotOverlay(d);
  // Lifetime + deposit: for both managed and unmanaged
  if (d.pnlSnapshot && (!d.running || d.rebalanceScanComplete)) {
    _updateNetReturn(
      d,
      t.ltTotal,
      t.ltDep,
      t.ltCurrentFees,
      t.ltPriceChange,
      t.ltRealized,
      t.ltResidual,
      t.ltInitialResidual,
    );
    _setDepositDisplay(
      t.ltDep,
      d.pnlSnapshot?.totalLifetimeDeposit,
      d.pnlSnapshot?.depositUsedFallback,
    );
  }
  // Historical price fetch succeeded if hodlBaseline.entryValue > 0;
  // otherwise we fall back to liveEpoch.entryValue (current price at bot start).
  const histOk = d.hodlBaseline?.entryValue > 0;
  refreshCurDepositDisplay(
    d.hodlBaseline?.entryValue || d.pnlSnapshot?.liveEpoch?.entryValue || 0,
    !histOk,
  );
}
export { _updateNetBreakdown };
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
    _setAprSpan("netILApr", il, ltDeposit, ltStartDate(d));
  }
  return il;
}
export function _updateNetReturn(
  d,
  total,
  ltDeposit,
  ltCurrentFees,
  ltPriceChange,
  ltRealized,
  ltResidual,
  ltInitialResidual,
) {
  const net = g("kpiNet");
  if (d.pnlSnapshot) {
    _setLeadingText(net, _fmtUsd(total));
    net.className =
      "kpi-value 9mm-pos-mgr-kpi-pct-row " +
      (_isDisplayZero(total) ? "neu" : total > 0 ? "pos" : "neg");
    _setPctSpan("kpiNetPct", total, ltDeposit);
    _setAprSpan("kpiNetApr", total, ltDeposit, ltStartDate(d));
    const _ll = g("ltPnlLabel"),
      _sd = ltStartDate(d);
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
    const resid = ltResidual || 0;
    const initResid = ltInitialResidual || 0;
    _updateNetBreakdown(
      ltPriceChange,
      ltRealized,
      ltGas2,
      resid,
      ltCompounded,
      initResid,
    );
    _setLtCurrentValue(d);
    // currentValue is LP-only; residuals are tracked separately.
    const cv = d.pnlSnapshot.currentValue || 0;
    Object.assign(_ltBreakdown, {
      currentFees: ltCurrentFees,
      compounded: ltCompounded,
      gas: ltGas2,
      priceChange: ltPriceChange,
      residual: resid,
      initialResidual: initResid,
      realized: ltRealized,
      total,
      currentValue: cv,
      deposit: ltDeposit,
    });
  }
  const il = _updateIL(d, ltDeposit);
  const ltComp = d.pnlSnapshot?.totalCompoundedUsd || 0;
  /*- Profit = Current Fees + Fees Compounded − Gas +/− IL/G.  Pass the
   *  fee earnings (currentFees + compounded) as the additive term and
   *  zero for "compounded subtraction" — _setProfitKpi's signature
   *  predates this model and still has a subtraction slot. */
  _setProfitKpi(
    "ltProfit",
    ltCurrentFees + ltComp,
    d.pnlSnapshot?.totalGas || 0,
    il,
    0,
  );
}
function _setLtCurrentValue(d) {
  const el = g("ltCurrentValue");
  if (!el) return;
  // currentValue is LP-only; residuals are tracked separately.
  const cv = d.pnlSnapshot.currentValue || 0;
  el.textContent = _fmtUsd(cv);
}
export {
  _showBaselineModal,
  checkHodlBaselineDialog,
} from "./dashboard-data-baseline.js";
export {
  _activeToken1Symbol,
  positionRangeVisual,
  updateRangePctLabels,
} from "./dashboard-data-range.js";
