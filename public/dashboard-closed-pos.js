/**
 * @file dashboard-closed-pos.js
 * @description Manages "history viewing mode" for closed (liquidity=0) LP
 * positions.  When the user browses to a closed position, this module fetches
 * historical data from the server and renders it into the existing KPI
 * elements without disrupting the bot's active position management.
 *
 * Depends on: dashboard-helpers.js (g, fmtDateTime),
 *             dashboard-data.js (_fmtUsd).
 */

import { g, fmtDateTime } from "./dashboard-helpers.js";
import { _fmtUsd } from "./dashboard-data.js";
import { setLeadingText } from "./dashboard-kpi-dom.js";

/** @type {boolean} Whether we are currently viewing a closed position. */
let _viewingClosed = false;

/** @type {object|null} The posStore entry for the closed position being viewed. */
let _closedPosEntry = null;

/**
 * Check whether the dashboard is currently in closed-position history view.
 * @returns {boolean}
 */
export function isViewingClosedPos() {
  return _viewingClosed;
}

/**
 * Enter closed-position history view.  Shows the amber banner, fetches
 * historical data from the server, and populates KPI elements.
 * @param {object} posEntry  Position entry from posStore (liquidity=0).
 */
export async function enterClosedPosView(posEntry) {
  _viewingClosed = true;
  _closedPosEntry = posEntry;

  // Render "CLOSED" status
  const statusEl = g("curPosStatus");
  if (statusEl) {
    statusEl.textContent = "CLOSED";
    statusEl.className = "9mm-pos-mgr-pos-status closed";
  }

  await _fetchAndRenderHistory(posEntry.tokenId);
}

/**
 * Fetch historical data for a tokenId and render into KPIs.
 * @param {string} tokenId  NFT token ID.
 */
async function _fetchAndRenderHistory(tokenId) {
  try {
    const res = await fetch("/api/position/" + tokenId + "/history");
    if (res.ok) {
      _renderHistoricalKpis(await res.json());
    } else {
      _renderNoData();
    }
  } catch {
    _renderNoData();
  }
}

/**
 * Re-fetch history data for the current closed position.
 * Called when the event scanner finishes while viewing a closed position.
 */
export async function refetchClosedPosHistory() {
  if (!_viewingClosed || !_closedPosEntry) return;
  await _fetchAndRenderHistory(_closedPosEntry.tokenId);
}

/**
 * Exit closed-position history view.  Hides the banner and lets the next
 * poll cycle repopulate live KPIs.
 */
export function exitClosedPosView() {
  _viewingClosed = false;
  _closedPosEntry = null;
  const dur = g("kpiPosDuration");
  if (dur) dur.style.color = "";
}

/**
 * Get the posStore entry for the closed position currently being viewed.
 * @returns {object|null}
 */
export function getClosedPosEntry() {
  return _closedPosEntry;
}

/**
 * Check if a value is present (not null/undefined/zero for USD fields).
 * @param {*} v  Value to check.
 * @returns {boolean}
 */
function _hasVal(v) {
  return v !== null && v !== undefined && v !== 0;
}

/**
 * Format a token USD price to a readable string with appropriate precision.
 * @param {number} price  USD price.
 * @returns {string}
 */
function _fmtPrice(price) {
  if (price >= 1) return "$" + price.toFixed(2);
  if (price >= 0.01) return "$" + price.toFixed(4);
  return "$" + price.toPrecision(4);
}

/**
 * Build a token-price summary string when total USD values are unavailable.
 * @param {number|null} p0  Token0 USD price.
 * @param {number|null} p1  Token1 USD price.
 * @param {string}      label  "at open" or "at close".
 * @returns {string|null}  Summary or null if no prices.
 */
function _priceSummary(p0, p1, label) {
  const parts = [];
  if (_hasVal(p0)) parts.push("token0 " + _fmtPrice(p0));
  if (_hasVal(p1)) parts.push("token1 " + _fmtPrice(p1));
  return parts.length ? parts.join(" / ") + " " + label : null;
}

/**
 * Render historical KPI values from the server response into existing DOM elements.
 * Shows available data (dates, tx hashes, token prices) even when total USD
 * values are missing — e.g. when the rebalance log was cleared but
 * GeckoTerminal historical prices are available.
 * @param {object} data  Response from GET /api/position/:tokenId/history.
 */
function _renderHistoricalKpis(data) {
  const hasExit = _hasVal(data.exitValueUsd);
  const hasEntry = _hasVal(data.entryValueUsd);

  // Current Value = exit value at close, or token prices if available
  const val = g("kpiValue");
  if (val) {
    if (hasExit) val.textContent = _fmtUsd(data.exitValueUsd);
    else {
      const s = _priceSummary(
        data.token0UsdPriceAtClose,
        data.token1UsdPriceAtClose,
        "at close",
      );
      val.textContent = s || "\u2014";
    }
  }

  // P&L = exit - entry (only if both are available)
  const pnl =
    hasExit && hasEntry ? data.exitValueUsd - data.entryValueUsd : null;
  _setLeadingKpi("kpiPnl", pnl);

  _renderFees(data, pnl);
  _renderDuration(data);
  _renderPnlSub(data);

  // Clear percentage/APR spans (not meaningful for closed positions)
  for (const id of ["kpiPnlPctVal", "kpiPnlApr", "curILPct"]) {
    const el = g(id);
    if (el) el.textContent = "";
  }

  // IL not calculable for closed positions without full HODL data
  _setLeadingKpi("curIL", null);
}

/**
 * Set the leading text node of a KPI element and apply sign-based CSS class.
 * @param {string}      id   Element ID.
 * @param {number|null} val  Value to display (null renders as "\u2014").
 */
function _setLeadingKpi(id, val) {
  const el = g(id);
  if (!el) return;
  setLeadingText(el, _fmtUsd(val));
  const cls = val === null ? "neu" : val > 0 ? "pos" : val < 0 ? "neg" : "neu";
  el.className = "kpi-value 9mm-pos-mgr-kpi-pct-row " + cls;
}

/**
 * Render fees and price change rows.
 * @param {object}      data  History API response.
 * @param {number|null} pnl   Computed P&L (exit - entry), or null.
 */
function _renderFees(data, pnl) {
  const feesEl = g("pnlFees");
  if (feesEl) {
    feesEl.textContent = _hasVal(data.feesEarnedUsd)
      ? _fmtUsd(data.feesEarnedUsd)
      : "\u2014";
    feesEl.className = "kpi-value " + (data.feesEarnedUsd > 0 ? "pos" : "neu");
  }
  const priceEl = g("pnlPrice");
  if (priceEl) {
    const hasFees = _hasVal(data.feesEarnedUsd);
    const priceChange =
      pnl !== null && hasFees ? pnl - data.feesEarnedUsd : null;
    priceEl.textContent =
      priceChange !== null ? _fmtUsd(priceChange) : "\u2014";
    priceEl.className =
      "kpi-value " +
      (priceChange > 0 ? "pos" : priceChange < 0 ? "neg" : "neu");
  }
}

/**
 * Render mint/close duration line with dates from event scanner.
 * @param {object} data  History API response.
 */
function _renderDuration(data) {
  const el = g("kpiPosDuration");
  if (!el) return;
  const parts = [];
  if (data.mintDate) parts.push("Minted: " + fmtDateTime(data.mintDate));
  if (data.closeDate) parts.push("Closed: " + fmtDateTime(data.closeDate));
  if (parts.length === 0) {
    el.textContent = "No date data available";
    return;
  }
  el.textContent = parts.join(" | ");
  el.style.color = "#888";
}

/**
 * Render the P&L sub-label with date range and data-source note.
 * @param {object} data  History API response.
 */
function _renderPnlSub(data) {
  const el = g("kpiPnlPct");
  if (!el) return;
  const hasDates = data.mintDate || data.closeDate;
  const hasUsd = _hasVal(data.exitValueUsd) || _hasVal(data.entryValueUsd);
  if (hasDates) {
    const mintStr = data.mintDate
      ? fmtDateTime(data.mintDate, { dateOnly: true })
      : "?";
    const closeStr = data.closeDate
      ? fmtDateTime(data.closeDate, { dateOnly: true })
      : "?";
    const suffix = hasUsd ? " (closed)" : " (closed \u2014 no USD data in log)";
    el.textContent = mintStr + " \u2192 " + closeStr + suffix;
  } else {
    el.textContent = "Closed position \u2014 no event data found";
  }
}

/**
 * Render placeholder values when the API request fails entirely.
 */
function _renderNoData() {
  for (const id of ["kpiValue"]) {
    const el = g(id);
    if (el) el.textContent = "\u2014";
  }
  _setLeadingKpi("kpiPnl", null);
  const durEl = g("kpiPosDuration");
  if (durEl) durEl.textContent = "No historical data available";
  const pnlSub = g("kpiPnlPct");
  if (pnlSub) pnlSub.textContent = "Closed position \u2014 server unavailable";
}
