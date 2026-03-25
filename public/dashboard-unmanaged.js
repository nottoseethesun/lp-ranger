/**
 * @file dashboard-unmanaged.js
 * @description One-shot detail fetch for unmanaged LP positions.
 *   When the user views an unmanaged position, this module fetches live
 *   pool state, token prices, composition, and value from the server
 *   and populates the dashboard KPIs.
 */

import { g, botConfig, truncName, fmtNum, fmtDateTime } from './dashboard-helpers.js';
import { positionRangeVisual, _fmtUsd } from './dashboard-data.js';
import { updateILDebugData } from './dashboard-il-debug.js';
import { posStore } from './dashboard-positions.js';

/** Update the composition bar + labels, or show grey "no price data" state. */
function _applyComposition(d, pos) {
  const tn0 = truncName(pos.token0Symbol || '?', 12), tn1 = truncName(pos.token1Symbol || '?', 12);
  const c0 = g('c0'), c1 = g('c1'), cl0 = g('cl0'), cl1 = g('cl1');
  if (d.composition === null) {
    if (c0) { c0.style.width = '50%'; c0.style.background = '#555'; }
    if (c1) { c1.style.width = '50%'; c1.style.background = '#555'; }
    if (cl0) cl0.textContent = tn0 + ': no price data';
    if (cl1) cl1.textContent = tn1 + ': no price data';
  } else {
    const r0 = d.composition;
    if (c0) { c0.style.width = (r0 * 100).toFixed(1) + '%'; c0.style.background = ''; }
    if (c1) { c1.style.width = ((1 - r0) * 100).toFixed(1) + '%'; c1.style.background = ''; }
    if (cl0) cl0.textContent = '\u25A0 ' + tn0 + ': ' + (r0 * 100).toFixed(0) + '%';
    if (cl1) cl1.textContent = '\u25A0 ' + tn1 + ': ' + ((1 - r0) * 100).toFixed(0) + '%';
  }
}

/** Set a KPI element's text and color class. */
function _setKpi(id, val) {
  const el = g(id); if (!el) return;
  if (val === null || val === undefined) { el.textContent = '\u2014'; return; }
  el.textContent = _fmtUsd(val);
  el.className = el.className.replace(/\b(pos|neg|neu)\b/g, '') + ' ' + (val > 0.005 ? 'pos' : val < -0.005 ? 'neg' : 'neu');
}

/** Populate the Lifetime panel + subtitle from one-shot data. */
function _applyLifetime(d) {
  _setKpi('kpiNet', d.netPnl);
  _setKpi('ltProfit', d.profit);
  _setKpi('netIL', d.il);
  const ltDep = g('lifetimeDepositDisplay'); if (ltDep && d.entryValue > 0) ltDep.textContent = '$usd ' + d.entryValue.toFixed(2);
  if (d.mintDate) {
    const sub = g('kpiPnlPct'); if (sub) sub.textContent = d.mintDate + ' \u2192 ' + new Date().toISOString().slice(0, 10);
    const days = ((Date.now() - (d.mintTimestamp || 0) * 1000) / 86400000).toFixed(2);
    const ltLabel = g('ltPnlLabel'); if (ltLabel) ltLabel.textContent = 'Net Profit and Loss Return over ' + days + ' days';
  }
}

/** Apply one-shot position details to the dashboard UI. */
function _apply(d, pos) {
  botConfig.price = d.poolState.price; botConfig.lower = d.lowerPrice; botConfig.upper = d.upperPrice;
  botConfig.tL = pos.tickLower; botConfig.tU = pos.tickUpper;
  const sym = truncName(pos.token1Symbol || '?', 12);
  const pml = g('pmlabel'); if (pml) { pml.textContent = fmtNum(d.poolState.price) + ' ' + sym; pml.title = String(d.poolState.price); }
  positionRangeVisual();
  // Range percent labels (normally set by _updatePriceMarker which skips unmanaged)
  const p = d.poolState.price, lo = d.lowerPrice, hi = d.upperPrice;
  if (p > 0) {
    const rLo = g('rangePctLower'), rHi = g('rangePctUpper');
    if (rLo) rLo.textContent = ((lo - p) / p * 100).toFixed(3) + '% below price';
    if (rHi) rHi.textContent = '+' + ((hi - p) / p * 100).toFixed(3) + '% above price';
  }
  // Current panel KPIs
  _setKpi('kpiValue', d.value > 0 ? d.value : null);
  _setKpi('pnlFees', d.feesUsd > 0 ? d.feesUsd : null);
  _setKpi('pnlPrice', d.priceGainLoss);
  _setKpi('kpiDeposit', d.entryValue > 0 ? d.entryValue : null);
  _setKpi('kpiPnl', d.netPnl);
  _setKpi('curProfit', d.profit);
  _setKpi('curIL', d.il);
  // Position age + mint date
  if (d.mintTimestamp) {
    const dur = g('kpiPosDuration');
    if (dur) {
      const ms = Date.now() - d.mintTimestamp * 1000;
      const dd = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), mm = Math.floor((ms % 3600000) / 60000);
      dur.textContent = 'Active: ' + dd + 'd ' + hh + 'h ' + mm + 'm \u00B7 Minted: ' + fmtDateTime(new Date(d.mintTimestamp * 1000));
    }
  }
  _applyLifetime(d);
  // Inject IL debug data so the "i" buttons work for unmanaged positions
  if (d.il !== null && d.il !== undefined && d.hodlAmount0 !== null) {
    const hodl = { hodlAmount0: d.hodlAmount0, hodlAmount1: d.hodlAmount1 };
    updateILDebugData({ pnlSnapshot: { totalIL: d.il, lifetimeIL: d.il,
      ilInputs: { lpValue: d.value, price0: d.price0, price1: d.price1, cur: hodl, lt: hodl } } }, posStore);
  }
  // Composition + balances
  _applyComposition(d, pos);
  const sw = g('sWpls'); if (sw) sw.textContent = d.amounts.amount0.toFixed(4);
  const su = g('sUsdc'); if (su) su.textContent = d.amounts.amount1.toFixed(4);
}

/** Fetch and display details for an unmanaged position (one-shot). */
export async function fetchUnmanagedDetails(pos) {
  if (!pos?.tokenId || !pos?.token0 || !pos?.token1 || !pos?.fee) return;
  try {
    const res = await fetch('/api/position/details', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: pos.tokenId, token0: pos.token0, token1: pos.token1, fee: pos.fee,
        tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: String(pos.liquidity || 0),
        walletAddress: pos.walletAddress, contractAddress: pos.contractAddress }) });
    const d = await res.json();
    if (d.ok) _apply(d, pos);
  } catch (e) { console.warn('[data] fetchUnmanagedDetails:', e.message); }
}
