/**
 * @file dashboard-param-help.js
 * @description Renders educational help modals for configurable dashboard
 * parameters.  Each circle-i button with a `data-param-help` attribute
 * opens a modal with structured content from param-help-content.js.
 *
 * Dismissal is handled by existing infrastructure:
 * - `[data-dismiss-modal]` delegated handler in dashboard-events-manage.js
 * - Escape key catches dynamic `[class*="pos-mgr-modal-overlay"]` elements
 */

import { PARAM_HELP } from "./param-help-content.js";
import {
  getLtBreakdown,
  getCurBreakdown,
  _fmtUsd,
} from "./dashboard-data-kpi.js";

const _MODAL_ID = "9mm-param-help-modal";

/**
 * Show the educational help modal for a parameter.
 * @param {string} key  The parameter key (matches a PARAM_HELP entry).
 */
export function showParamHelp(key) {
  const entry = PARAM_HELP[key];
  if (!entry) return;
  // Remove any existing help modal to prevent stacking
  const existing = document.getElementById(_MODAL_ID);
  if (existing) existing.remove();

  const sections = entry.sections
    .map(
      (s) =>
        '<h4 class="9mm-pos-mgr-help-heading">' +
        s.heading +
        "</h4><p>" +
        s.body +
        "</p>",
    )
    .join("");
  const sub = entry.subtitle
    ? '<p class="9mm-pos-mgr-help-subtitle">' + entry.subtitle + "</p>"
    : "";

  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = _MODAL_ID;
  overlay.innerHTML =
    '<div class="9mm-pos-mgr-modal 9mm-pos-mgr-modal-help">' +
    "<h3>" +
    entry.title +
    "</h3>" +
    sub +
    '<div class="9mm-pos-mgr-modal-body">' +
    sections +
    "</div>" +
    '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>Close</button>' +
    "</div>";
  document.body.appendChild(overlay);
}

/**
 * Bind a single delegated click handler for all `[data-param-help]` buttons.
 * Call once after DOM is ready.
 */
export function bindParamHelpButtons() {
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-param-help]");
    if (!btn) return;
    showParamHelp(btn.dataset.paramHelp);
  });
}

/**
 * Build and show a P&L breakdown info dialog.
 * @param {string} title       Dialog title.
 * @param {object} b           Breakdown cache (fees, compounded, gas, etc.).
 * @param {string} depositLabel  Label for the deposit row.
 * @param {string} feesLabel     Label for the fees row.
 * @param {string} [extraHtml]   Additional HTML appended after the explanation.
 */
function _showPnlDialog(title, b, depositLabel, feesLabel, extraHtml) {
  const existing = document.getElementById(_MODAL_ID);
  if (existing) existing.remove();
  const f = (v) => _fmtUsd(v);
  const row = (label, val, sign) =>
    "<tr><td>" + label + "</td><td>" + (sign || "") + f(val) + "</td></tr>";
  const table =
    '<table class="9mm-pos-mgr-pnl-breakdown-table">' +
    row(feesLabel, b.fees, "+") +
    row("Fees Compounded (subtracted)", b.compounded, "\u2212") +
    row("Gas Costs", b.gas, "\u2212") +
    row("Price Change", b.priceChange, b.priceChange >= 0 ? "+" : "") +
    row("Realized Gains", b.realized, "+") +
    '<tr class="9mm-pos-mgr-pnl-breakdown-total"><td><strong>' +
    "Net P&amp;L</strong></td><td><strong>" +
    f(b.total) +
    "</strong></td></tr></table>";
  const explanation =
    '<h4 class="9mm-pos-mgr-help-heading">Price Change</h4>' +
    "<p><strong>Price Change</strong> = Current Value (" +
    f(b.currentValue) +
    ") \u2212 " +
    depositLabel +
    " (" +
    f(b.deposit) +
    ") = " +
    f(b.priceChange) +
    ". This captures both token price appreciation " +
    "and impermanent loss together. If the tokens in your pool changed " +
    "in price since you deposited, this figure reflects that net effect " +
    "on your position\u2019s value.</p>" +
    '<h4 class="9mm-pos-mgr-help-heading">Profit</h4>' +
    "<p><strong>Profit</strong> is a separate metric shown below: " +
    feesLabel +
    " \u2212 Fees Compounded \u2212 Gas +/\u2212 IL/G. " +
    "It excludes Price Change but includes Impermanent Loss/Gain " +
    "explicitly, showing how the position performed as a fee-earning " +
    "instrument independent of token price movements.</p>";
  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = _MODAL_ID;
  overlay.innerHTML =
    '<div class="9mm-pos-mgr-modal 9mm-pos-mgr-modal-help">' +
    "<h3>" +
    title +
    "</h3>" +
    '<div class="9mm-pos-mgr-modal-body">' +
    table +
    explanation +
    (extraHtml || "") +
    "</div>" +
    '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>Close</button>' +
    "</div>";
  document.body.appendChild(overlay);
}

/** Show the Lifetime Net P&L breakdown info dialog. */
export function showNetPnlBreakdown() {
  const daysNote =
    '<h4 class="9mm-pos-mgr-help-heading">Return Period (Days)</h4>' +
    "<p>The number of days shown in &ldquo;Return Over X Days&rdquo; is " +
    "measured from the date of the <strong>first liquidity position</strong> " +
    "that this wallet created in this pool. LP Ranger scans on-chain history " +
    "(up to 5 years back) to find the earliest mint event for this wallet " +
    "and pool pair. The day count runs from that first position&rsquo;s " +
    "mint date to today, regardless of how many subsequent positions " +
    "(rebalances) have occurred in between.</p>";
  _showPnlDialog(
    "Lifetime Net P&amp;L Breakdown",
    getLtBreakdown(),
    "Total Lifetime Deposit",
    "Lifetime Fees",
    daysNote,
  );
}

/** Show the Current Position Net P&L breakdown info dialog. */
export function showCurPnlBreakdown() {
  _showPnlDialog(
    "Current Position Net P&amp;L Breakdown",
    getCurBreakdown(),
    "Initial Deposit",
    "Fees Earned",
  );
}
