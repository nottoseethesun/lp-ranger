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
import { cloneTpl } from "./dashboard-helpers.js";

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

  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = _MODAL_ID;
  const frag = cloneTpl("tplParamHelpModal");
  if (!frag) return;
  frag.querySelector('[data-tpl="title"]').textContent = entry.title;
  const subEl = frag.querySelector('[data-tpl="subtitle"]');
  if (entry.subtitle) {
    subEl.textContent = entry.subtitle;
    subEl.hidden = false;
  } else {
    subEl.remove();
  }
  const bodyEl = frag.querySelector('[data-tpl="body"]');
  for (const s of entry.sections) {
    const sec = cloneTpl("tplParamHelpSection");
    if (!sec) continue;
    sec.querySelector('[data-tpl="heading"]').textContent = s.heading;
    /*- PARAM_HELP bodies contain rich text (<strong>, <br>, &mdash;)
     *  authored in param-help-content.js. That content file is the
     *  intentional home for this markup — the HTML-in-JS rule targets
     *  layout markup mixed into logic files, not editorial content. */
    sec.querySelector('[data-tpl="body"]').innerHTML = s.body;
    bodyEl.appendChild(sec);
  }
  overlay.appendChild(frag);
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
function _buildPnlTable(b, feesLabel) {
  const f = (v) => _fmtUsd(v);
  const frag = cloneTpl("tplPnlBreakdownTable");
  if (!frag) return null;
  const set = (key, val) => {
    const el = frag.querySelector(`[data-tpl="${key}"]`);
    if (el) el.textContent = val;
  };
  set("feesLabel", feesLabel);
  set("fees", "+" + f(b.fees));
  set("compounded", "\u2212" + f(b.compounded));
  set("gas", "\u2212" + f(b.gas));
  set("priceChange", (b.priceChange >= 0 ? "+" : "") + f(b.priceChange));
  set("realized", "+" + f(b.realized));
  set("total", f(b.total));
  return frag;
}

function _buildPnlExplanation(b, depositLabel, feesLabel) {
  const f = (v) => _fmtUsd(v);
  const frag = cloneTpl("tplPnlBreakdownExplanation");
  if (!frag) return null;
  const set = (key, val) => {
    for (const el of frag.querySelectorAll(`[data-tpl="${key}"]`))
      el.textContent = val;
  };
  set("currentValue", f(b.currentValue));
  set("depositLabel", depositLabel);
  set("deposit", f(b.deposit));
  set("priceChange", f(b.priceChange));
  set("feesLabel", feesLabel);
  return frag;
}

function _showPnlDialog(title, b, depositLabel, feesLabel, extraFrag) {
  const existing = document.getElementById(_MODAL_ID);
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = _MODAL_ID;
  const frag = cloneTpl("tplPnlBreakdownModal");
  if (!frag) return;
  frag.querySelector('[data-tpl="title"]').textContent = title;
  const bodyEl = frag.querySelector('[data-tpl="body"]');
  const table = _buildPnlTable(b, feesLabel);
  if (table) bodyEl.appendChild(table);
  const explanation = _buildPnlExplanation(b, depositLabel, feesLabel);
  if (explanation) bodyEl.appendChild(explanation);
  if (extraFrag) bodyEl.appendChild(extraFrag);
  overlay.appendChild(frag);
  document.body.appendChild(overlay);
}

/** Show the Lifetime Net P&L breakdown info dialog. */
export function showNetPnlBreakdown() {
  const daysNote = cloneTpl("tplPnlBreakdownDaysNote");
  _showPnlDialog(
    "Lifetime Net P\u0026L Breakdown",
    getLtBreakdown(),
    "Total Lifetime Deposit",
    "Lifetime Fees",
    daysNote,
  );
}

/** Show the Current Position Net P&L breakdown info dialog. */
export function showCurPnlBreakdown() {
  _showPnlDialog(
    "Current Position Net P\u0026L Breakdown",
    getCurBreakdown(),
    "Initial Deposit",
    "Fees Earned",
  );
}
