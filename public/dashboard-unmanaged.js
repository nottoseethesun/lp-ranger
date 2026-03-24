/**
 * @file dashboard-unmanaged.js
 * @description One-shot detail fetch for unmanaged LP positions.
 *   When the user views an unmanaged position, this module fetches live
 *   pool state, token prices, composition, and value from the server
 *   and populates the dashboard KPIs.
 */

import { g, botConfig, truncName } from './dashboard-helpers.js';
import { positionRangeVisual, _fmtUsd } from './dashboard-data.js';

/** Apply one-shot position details to the dashboard UI. */
function _apply(d, pos) {
  // Range chart
  botConfig.price = d.poolState.price; botConfig.lower = d.lowerPrice; botConfig.upper = d.upperPrice;
  botConfig.tL = pos.tickLower; botConfig.tU = pos.tickUpper;
  positionRangeVisual();
  // Current Value (Deposit stays as — since we don't have historical entry value)
  const val = g('kpiValue'); if (val) val.textContent = d.value > 0 ? _fmtUsd(d.value) : '\u2014';
  // Unclaimed fees
  const fe = g('pnlFees'); if (fe && d.feesUsd > 0) fe.textContent = _fmtUsd(d.feesUsd);
  // Token composition bar
  const r0 = d.composition, c0 = g('c0'), c1 = g('c1');
  if (c0) c0.style.width = (r0 * 100).toFixed(1) + '%'; if (c1) c1.style.width = ((1 - r0) * 100).toFixed(1) + '%';
  const tn0 = truncName(pos.token0Symbol || '?', 12), tn1 = truncName(pos.token1Symbol || '?', 12);
  const cl0 = g('cl0'), cl1 = g('cl1');
  if (cl0) cl0.textContent = '\u25A0 ' + tn0 + ': ' + (r0 * 100).toFixed(0) + '%';
  if (cl1) cl1.textContent = '\u25A0 ' + tn1 + ': ' + ((1 - r0) * 100).toFixed(0) + '%';
  // Token balances
  const sw = g('sWpls'); if (sw) sw.textContent = d.amounts.amount0.toFixed(4);
  const su = g('sUsdc'); if (su) su.textContent = d.amounts.amount1.toFixed(4);
}

/** Fetch and display details for an unmanaged position (one-shot). */
export async function fetchUnmanagedDetails(pos) {
  if (!pos?.tokenId || !pos?.token0 || !pos?.token1 || !pos?.fee) return;
  try {
    const res = await fetch('/api/position/details', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: pos.tokenId, token0: pos.token0, token1: pos.token1, fee: pos.fee,
        tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: String(pos.liquidity || 0) }) });
    const d = await res.json();
    if (d.ok) _apply(d, pos);
  } catch (e) { console.warn('[data] fetchUnmanagedDetails:', e.message); }
}
