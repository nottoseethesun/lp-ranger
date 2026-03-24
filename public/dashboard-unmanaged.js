/**
 * @file dashboard-unmanaged.js
 * @description One-shot detail fetch for unmanaged LP positions.
 *   When the user views an unmanaged position, this module fetches live
 *   pool state, token prices, composition, and value from the server
 *   and populates the dashboard KPIs.
 */

import { g, botConfig, truncName } from './dashboard-helpers.js';
import { positionRangeVisual, _fmtUsd } from './dashboard-data.js';

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

/** Apply one-shot position details to the dashboard UI. */
function _apply(d, pos) {
  botConfig.price = d.poolState.price; botConfig.lower = d.lowerPrice; botConfig.upper = d.upperPrice;
  botConfig.tL = pos.tickLower; botConfig.tU = pos.tickUpper;
  positionRangeVisual();
  // Current panel KPIs
  _setKpi('kpiValue', d.value > 0 ? d.value : null);
  _setKpi('pnlFees', d.feesUsd > 0 ? d.feesUsd : null);
  _setKpi('pnlPrice', d.priceGainLoss);
  _setKpi('kpiDeposit', d.entryValue > 0 ? d.entryValue : null);
  _setKpi('kpiPnl', d.netPnl);
  _setKpi('curProfit', d.profit);
  _setKpi('curIL', d.il);
  // Mint date
  if (d.mintDate) { const dur = g('kpiPosDuration'); if (dur) dur.textContent = 'Since ' + d.mintDate; }
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
