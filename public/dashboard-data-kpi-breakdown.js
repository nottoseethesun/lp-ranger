/**
 * @file dashboard-data-kpi-breakdown.js
 * @description Populates the six pre-declared rows in the Lifetime Net
 *   P&L breakdown table (kpiNetBreakdown): Lifetime Fees, Fees
 *   Compounded, Gas, Price Change, Wallet Residual, Realized Gains.
 *
 *   The rows are authored statically in index.html with stable IDs —
 *   this module only writes textContent per the KISS + no-HTML-in-JS
 *   rules.  Extracted from dashboard-data-kpi.js to keep that file
 *   under the 500-line ESLint limit.
 */

import { g } from "./dashboard-helpers.js";
import { _fmtUsd } from "./dashboard-fmt-usd.js";

/** IDs of the six breakdown rows — exported so reset paths can clear them. */
export const LT_BD_IDS = [
  "ltBdFees",
  "ltBdCompounded",
  "ltBdGas",
  "ltBdPriceChange",
  "ltBdResidual",
  "ltBdRealized",
];

/** Write a row, colour-coding pos/neg to match the KPI cards (green/red). */
function _writeRow(el, val, signed) {
  if (val === undefined || val === null) {
    el.textContent = "\u2014";
    el.classList.remove("pos", "neg", "neu");
    el.classList.add("neu");
    return;
  }
  /*- _fmtUsd already prefixes a "-" for negative numbers; for "subtracted"
   *  rows we pass a positive value with signed<0, so flip the sign before
   *  formatting to get the same minus prefix via the formatter. */
  const formatted = _fmtUsd(signed < 0 ? -Math.abs(val) : Math.abs(val));
  el.textContent = signed < 0 ? formatted.replace("-", "\u2212") : formatted;
  el.classList.remove("pos", "neg", "neu");
  if (signed > 0) el.classList.add("pos");
  else if (signed < 0) el.classList.add("neg");
  else el.classList.add("neu");
}

/** Normal row: green for positive, red for negative, no explicit "+" sign. */
function _setRow(id, val) {
  const el = g(id);
  if (!el) return;
  _writeRow(el, val, val || 0);
}

/**
 * Write a row whose value is always subtracted from the total (compounded
 * fees, gas).  Raw value is stored positive but is shown with a leading
 * minus sign and red colour so the breakdown reads as a true summation.
 */
function _setSubtracted(id, val) {
  const el = g(id);
  if (!el) return;
  if (val === undefined || val === null) {
    _writeRow(el, null, 0);
    return;
  }
  const v = val || 0;
  _writeRow(el, v, v > 0 ? -1 : 0);
}

/**
 * Populate the six breakdown rows.
 * @param {number} fees        Lifetime fees earned (USD).
 * @param {number} priceChange Lifetime price change (currentValue − deposit).
 * @param {number} realized    User-entered realized gains (USD).
 * @param {number} compounded  Lifetime compounded fees (USD, subtracted).
 * @param {number} gas         Lifetime gas spent (USD, subtracted).
 * @param {number} residual    Wallet residual (pool tokens held, USD).
 */
export function updateNetBreakdown(
  fees,
  priceChange,
  realized,
  compounded,
  gas,
  residual,
) {
  _setRow("ltBdFees", fees);
  _setSubtracted("ltBdCompounded", compounded);
  _setSubtracted("ltBdGas", gas);
  _setRow("ltBdPriceChange", priceChange);
  _setRow("ltBdResidual", residual);
  _setRow("ltBdRealized", realized);
}
