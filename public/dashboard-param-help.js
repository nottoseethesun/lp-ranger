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

import { buildParamHelp } from "./param-help-content.js";
import { helpFigures } from "./dashboard-help-figures.js";
import { log } from "./dashboard-log.js";
import { getLtBreakdown, getCurBreakdown } from "./dashboard-data-kpi.js";
import { _fmtUsd } from "./dashboard-fmt-usd.js";
import { cloneTpl, truncName } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";
import { POSITION_DIALOG_ATTRIBUTE } from "./dashboard-position-dialogs.js";

const _MODAL_ID = "9mm-param-help-modal";

/** Longest token-symbol length rendered in dynamic help examples. */
const _TOKEN_NAME_MAX_CHARS = 16;

/*- Token symbols come from on-chain contract metadata, so they are
 *  untrusted input.  Section bodies render via innerHTML (editorial
 *  rich text), so any substituted symbol must be HTML-escaped. */
function _escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Substitute the `{{token0}}` / `{{token1}}` placeholders in a help
 * section body with concrete token names.  Names are HTML-escaped and
 * truncated to 16 characters.  Empty/missing names fall back to the
 * literal "Token 0" / "Token 1" so the sentence still reads.
 * @param {string} body  Section body (may contain placeholders).
 * @param {string|null|undefined} token0Symbol
 * @param {string|null|undefined} token1Symbol
 * @returns {string}
 */
export function _substituteTokenNames(body, token0Symbol, token1Symbol) {
  const t0 = token0Symbol
    ? _escapeHtml(truncName(token0Symbol, _TOKEN_NAME_MAX_CHARS))
    : "Token 0";
  const t1 = token1Symbol
    ? _escapeHtml(truncName(token1Symbol, _TOKEN_NAME_MAX_CHARS))
    : "Token 1";
  return body.replaceAll("{{token0}}", t0).replaceAll("{{token1}}", t1);
}

/**
 * Show the educational help modal for a parameter.
 *
 * The help states the figures this install runs on, which come from the
 * server shortly after startup; until they have arrived there is nothing
 * true to show, so the dialog does not open and the console says why.
 *
 * @param {string} key  The parameter key (matches a `buildParamHelp` entry).
 */
export function showParamHelp(key) {
  const figures = helpFigures();
  if (figures === null) {
    log.warn(
      "[lp-ranger] [help] the help's figures have not arrived from the server yet; %s not shown",
      key,
    );
    return;
  }
  const entry = buildParamHelp(figures)[key];
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
  const active = posStore.getActive();
  const bodyEl = frag.querySelector('[data-tpl="body"]');
  for (const s of entry.sections) {
    const sec = cloneTpl("tplParamHelpSection");
    if (!sec) continue;
    sec.querySelector('[data-tpl="heading"]').textContent = s.heading;
    /*-
     *  Help bodies contain rich text (<strong>, <br>, &mdash;)
     *  authored in param-help-content.js. That content file is the
     *  intentional home for this markup — the HTML-in-JS rule targets
     *  layout markup mixed into logic files, not editorial content.
     *  Dynamic token names are substituted (escaped + truncated) so
     *  e.g. the per-token slippage dialogs read "when Wrapped Pulse
     *  is traded for PulseX" for the active position.
     */
    sec.querySelector('[data-tpl="body"]').innerHTML = _substituteTokenNames(
      s.body,
      active?.token0Symbol,
      active?.token1Symbol,
    );
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
    /*- NOTE: an info icon must never be nested inside a <label> that
     *  wraps a form control.  A click anywhere in a label activates its
     *  control, so opening the help dialog would also flip the setting.
     *  `preventDefault()` here is NOT a reliable guard (it suppresses
     *  the activation in some engines and not others), so the rule is
     *  structural: put the icon beside the label, never inside it.  See
     *  the "No Override" row in Bot Settings → Range and the
     *  Auto-compound row in Mission Control for the correct shape. */
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
function _buildPnlTable(b, feesLabel, isLifetime) {
  const f = (v) => _fmtUsd(v);
  const frag = cloneTpl(
    isLifetime ? "tplPnlBreakdownTableLt" : "tplPnlBreakdownTable",
  );
  if (!frag) return null;
  const set = (key, val) => {
    const el = frag.querySelector(`[data-tpl="${key}"]`);
    if (el) el.textContent = val;
  };
  if (isLifetime) {
    /*-
     *  Lifetime: Net P&L adds Current Fees; Fees Compounded is shown for
     *  reference, unsigned, since those fees are already inside Current
     *  Value (`_resolveKpiTotals`). Gas is subtracted.
     */
    set("currentFees", f(b.currentFees || 0));
    set("compounded", f(b.compounded));
    set("gas", "\u2212" + f(b.gas));
  } else {
    /*-
     *  Current: Net P&L is Price Change + Fees Earned + Realized Gains.
     *  Fees Compounded and Gas are shown for reference, unsigned, since
     *  neither enters the total (`_resolveKpiTotals`).
     */
    set("feesLabel", feesLabel);
    set("fees", f(b.fees));
    set("compounded", f(b.compounded));
    set("gas", f(b.gas));
  }
  set("priceChange", f(b.priceChange));
  set("residual", f(b.residual || 0));
  /*-
   *  The residual rows are in the Lifetime table only; the Current one
   *  has none, so these find nothing there. Initial Wallet Residual is
   *  subtracted from Lifetime Net P&L (the unicode minus prefix matches
   *  the other subtracted rows and dashboard-data-kpi-breakdown's
   *  _setSubtracted formatting).
   */
  set("initialResidual", "\u2212" + f(b.initialResidual || 0));
  set("realized", f(b.realized));
  set("total", f(b.total));
  return frag;
}

function _buildPnlExplanation(b, depositLabel, feesLabel, isLifetime) {
  const f = (v) => _fmtUsd(v);
  const frag = cloneTpl(
    isLifetime ? "tplPnlBreakdownExplanationLt" : "tplPnlBreakdownExplanation",
  );
  if (!frag) return null;
  const set = (key, val) => {
    for (const el of frag.querySelectorAll(`[data-tpl="${key}"]`))
      el.textContent = val;
  };
  set("currentValue", f(b.currentValue));
  set("depositLabel", depositLabel);
  set("deposit", f(b.deposit));
  set("priceChange", f(b.priceChange));
  if (isLifetime) {
    set("currentFees", f(b.currentFees || 0));
    set("compounded", f(b.compounded));
  } else {
    set("feesLabel", feesLabel);
  }
  return frag;
}

function _showPnlDialog(title, b, depositLabel, feesLabel, extraFrag) {
  const isLifetime = title.startsWith("Lifetime");
  const existing = document.getElementById(_MODAL_ID);
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "9mm-pos-mgr-modal-overlay";
  overlay.id = _MODAL_ID;
  // The figures of the position on screen: a switch closes it.
  overlay.setAttribute(POSITION_DIALOG_ATTRIBUTE, "");
  const frag = cloneTpl("tplPnlBreakdownModal");
  if (!frag) return;
  frag.querySelector('[data-tpl="title"]').textContent = title;
  const bodyEl = frag.querySelector('[data-tpl="body"]');
  const table = _buildPnlTable(b, feesLabel, isLifetime);
  if (table) bodyEl.appendChild(table);
  const explanation = _buildPnlExplanation(
    b,
    depositLabel,
    feesLabel,
    isLifetime,
  );
  if (explanation) bodyEl.appendChild(explanation);
  if (extraFrag) bodyEl.appendChild(extraFrag);
  overlay.appendChild(frag);
  document.body.appendChild(overlay);
}

/** Show the Lifetime Net P&L breakdown info dialog. */
export function showNetPnlBreakdown() {
  const daysNote = cloneTpl("tplPnlBreakdownDaysNote");
  /*- feesLabel is unused on the Lifetime template (which has its own
   *  "Current Fees" + "Fees Compounded" rows); pass an empty string
   *  rather than the now-removed "Lifetime Fees" label. */
  _showPnlDialog(
    "Lifetime Net P\u0026L Breakdown",
    getLtBreakdown(),
    "Total Lifetime Deposit",
    "",
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
