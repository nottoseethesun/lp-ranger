/**
 * @file dashboard-gas-badge.js
 * @description Two-tier gas-status badge painter for Mission Control.
 *
 * Reads `global.gasStatus` from /api/status (built by the server from
 * src/gas-monitor.js) and paints an amber "Gas Running Low" badge at
 * tier 1, or a blinking critical badge at tier 2 when the wallet has
 * less than one worst-case rebalance worth of native token.
 *
 * Hidden entirely when `level === 'ok'` or `gasStatus` is null (no
 * managed positions yet, so no observation has been recorded).
 */
import { g } from "./dashboard-helpers.js";

const _CRIT_CLASS = "9mm-pos-mgr-gas-critical";
const _HIDDEN_CLASS = "9mm-pos-mgr-gas-hidden";

function _fmtUsd(n) {
  if (!isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString();
}

function _fmtNative(n) {
  if (!isFinite(n) || n <= 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(2);
  return Math.round(n).toLocaleString();
}

function _tooltipFor(gs) {
  const balN = _fmtNative(gs.balanceNative);
  const balU = _fmtUsd(gs.balanceUsd);
  const recN = _fmtNative(gs.recommendedNative);
  const recU = _fmtUsd(gs.recommendedUsd);
  const floorN = _fmtNative(gs.floorNative);
  const floorU = _fmtUsd(gs.floorUsd);
  const nPos = gs.positionCount;
  if (gs.level === "critical") {
    return (
      "CRITICAL: wallet has " +
      balN +
      " (" +
      balU +
      ") — below the one-rebalance floor of " +
      floorN +
      " (" +
      floorU +
      "). The next rebalance will likely fail with out-of-gas. " +
      "Top up immediately; the recommended level for " +
      nPos +
      " managed position(s) is " +
      recN +
      " (" +
      recU +
      ")."
    );
  }
  return (
    "Wallet has " +
    balN +
    " (" +
    balU +
    ") — below the recommended level of " +
    recN +
    " (" +
    recU +
    ") for " +
    nPos +
    " managed position(s). " +
    "Top up to the recommended amount to keep positions managed reliably. " +
    "One-rebalance floor is " +
    floorN +
    " (" +
    floorU +
    ")."
  );
}

function _labelFor(gs) {
  if (gs.level === "critical") return "GAS CRITICAL — Top Up Now";
  return "Gas Running Low";
}

function _detailFor(gs) {
  return (
    _fmtNative(gs.balanceNative) +
    " \u2248 " +
    _fmtUsd(gs.balanceUsd) +
    " / need " +
    _fmtUsd(gs.recommendedUsd)
  );
}

/**
 * Paint the gas-status badge from /api/status.global.gasStatus.
 * @param {object|undefined} d  Status payload.
 */
export function updateGasStatusBadge(d) {
  const badge = g("gasStatusBadge");
  if (!badge) return;
  const gs = d?.gasStatus;
  if (!gs || gs.level === "ok") {
    badge.classList.add(_HIDDEN_CLASS);
    badge.classList.remove(_CRIT_CLASS);
    return;
  }
  badge.classList.remove(_HIDDEN_CLASS);
  badge.classList.toggle(_CRIT_CLASS, gs.level === "critical");
  const text = g("gasStatusText");
  const detail = g("gasStatusDetail");
  if (text) text.textContent = _labelFor(gs);
  if (detail) detail.textContent = _detailFor(gs);
  badge.title = _tooltipFor(gs);
}
