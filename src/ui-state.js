/**
 * @file ui-state.js
 * @module uiState
 * @description
 * Manages the dashboard's reactive state and all DOM-update routines.
 * Acts as the View-Model layer: it consumes snapshots from pnl-tracker and
 * throttle, then pushes formatted values into the DOM.
 *
 * Design choices
 * ──────────────
 * - No framework dependency; plain DOM manipulation via `getElementById`.
 * - All formatting is in pure functions so they can be unit-tested without
 *   a DOM (they just return strings).
 * - DOM mutation is isolated to `applyKpis`, `applyRangeBar`,
 *   and `applyPositionType` so tests can stub them cheaply.
 *
 * @example
 * import { formatPnl, formatCountdown, applyKpis } from './ui-state.js';
 * const label = formatPnl(42.50);   // '+$42.50'
 */

'use strict';

// ── Pure formatting helpers (fully unit-testable, no DOM) ────────────────────

/**
 * Format a USD P&L value with sign and 2 decimal places.
 * @param {number} value
 * @returns {string}  e.g. '+$42.50' or '-$3.14'
 */
function formatPnl(value) {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Format a USD value (no sign, 2 decimals).
 * @param {number} value
 * @returns {string}
 */
function formatUsd(value) {
  return `$${value.toFixed(2)}`;
}

/**
 * Format a small USD value with 4 decimal places (for fees / gas).
 * @param {number} value
 * @returns {string}
 */
function formatUsd4(value) {
  return `$${Math.abs(value).toFixed(4)}`;
}

/**
 * Format a percentage value with sign and 2 decimal places.
 * @param {number} pct  Raw percentage (e.g. 5.25 for 5.25%).
 * @returns {string}
 */
function formatPct(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Format a millisecond duration as MM:SS countdown string.
 * Returns 'READY' when ms ≤ 0.
 * @param {number} ms
 * @returns {string}
 */
function formatCountdown(ms) {
  if (ms <= 0) return 'READY';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a millisecond duration as a short human string.
 * @param {number} ms
 * @returns {string}  e.g. '10m', '1h 30m', '45s'
 */
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m${totalSec % 60 ? ` ${totalSec % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Format an Ethereum/PulseChain address to a short display form.
 * @param {string} address
 * @returns {string}  e.g. '0xAbCd…ef12'
 */
function formatShortAddress(address) {
  if (!address || address.length < 12) return address || '—';
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Determine the CSS class suffix for a numeric value.
 * @param {number} value
 * @returns {'pos'|'neg'|'neu'}
 */
function signClass(value) {
  if (value > 0)  return 'pos';
  if (value < 0)  return 'neg';
  return 'neu';
}

/**
 * Compute the throttle bar fill percentage and its colour class.
 * @param {number} count  Rebalances done today.
 * @param {number} max    Daily maximum.
 * @returns {{ pct: number, colorVar: string }}
 */
function throttleBarStyle(count, max) {
  const pct = Math.min(100, max > 0 ? (count / max) * 100 : 0);
  let colorVar = 'var(--accent3)';
  if (pct >= 90) colorVar = 'var(--danger)';
  else if (pct >= 60) colorVar = 'var(--warn)';
  return { pct, colorVar };
}

/**
 * Build the range banner state descriptor.
 * @param {boolean} inRange
 * @param {boolean} allowed       Whether throttle permits a rebalance now.
 * @param {boolean} doublingActive
 * @param {number}  msUntilAllowed
 * @returns {{ className: string, icon: string, label: string }}
 */
function rangeBannerState(inRange, allowed, doublingActive, msUntilAllowed) {
  if (inRange) {
    return { className: 'range-status-banner in', icon: '✓', label: 'PRICE IN RANGE — EARNING FEES' };
  }
  if (!allowed && doublingActive) {
    return {
      className: 'range-status-banner dbl',
      icon:      '⚡',
      label:     `OUT OF RANGE — DOUBLING WAIT: ${formatCountdown(msUntilAllowed)}`,
    };
  }
  if (!allowed) {
    return {
      className: 'range-status-banner wait',
      icon:      '⏳',
      label:     `OUT OF RANGE — WAITING: ${formatCountdown(msUntilAllowed)}`,
    };
  }
  return { className: 'range-status-banner out', icon: '✗', label: 'OUT OF RANGE — REBALANCE TRIGGERED' };
}

/**
 * Derive position-type display info from a detection result.
 * @param {'nft'|'erc20'|'unknown'} posType
 * @param {string} tokenIdOrContract  NFT ID or ERC-20 contract address.
 * @returns {{ badgeText: string, badgeClass: string, stripLabel: string, stripValue: string }}
 */
function positionTypeMeta(posType, tokenIdOrContract) {
  if (posType === 'nft') {
    return {
      badgeText:  'NFT POSITION',
      badgeClass: 'pt-badge nft',
      stripLabel: 'Position NFT #',
      stripValue: tokenIdOrContract || '—',
    };
  }
  if (posType === 'erc20') {
    return {
      badgeText:  'ERC-20 POSITION',
      badgeClass: 'pt-badge erc20',
      stripLabel: 'ERC-20 Contract: ',
      stripValue: formatShortAddress(tokenIdOrContract),
    };
  }
  return {
    badgeText:  'DETECTING…',
    badgeClass: 'pt-badge',
    stripLabel: 'Position: ',
    stripValue: '—',
  };
}

// ── DOM mutation helpers (require a real DOM) ─────────────────────────────────

/**
 * Set text content and className of a DOM element by id.
 * Silently ignores missing elements (safe in test contexts with no DOM).
 * @param {string} id
 * @param {string} text
 * @param {string} [className]
 */
function setEl(id, text, className) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (className !== null && className !== undefined) el.className = className;
}

/**
 * Apply KPI card values to the DOM from a P&L snapshot and throttle state.
 * @param {import('./pnl-tracker.js').PnlSnapshot} snap
 * @param {import('./throttle.js').ThrottleState}  throttleState
 * @param {import('./throttle.js').CanRebalanceResult} canReb
 * @param {number} daysRunning
 */
function applyKpis(snap, throttleState, canReb, daysRunning) {
  const pct = daysRunning > 0
    ? (snap.totalFees / snap.initialDeposit) * (365 / daysRunning) * 100
    : 0;

  setEl('kpiPnl',    formatPnl(snap.cumulativePnl),
                     `kpi-value ${signClass(snap.cumulativePnl)}`);
  setEl('kpiPnlPct', `${formatPct(snap.cumulativePnl / snap.initialDeposit * 100)} since first deposit`);
  setEl('kpiValue',  formatUsd(snap.currentValue));
  setEl('kpiDeposit',`deposited: ${formatUsd(snap.initialDeposit)}`);
  setEl('kpiFees',   `+${formatUsd(snap.totalFees)}`);
  setEl('kpiApr',    `APR: ${pct.toFixed(1)}%`);
  setEl('kpiIL',     `-${formatUsd(snap.totalIL)}`);
  setEl('kpiILpct',  `${(snap.totalIL / snap.initialDeposit * 100).toFixed(3)}% vs HODL`);
  setEl('kpiReb',    String(snap.closedEpochs.length));
  setEl('kpiGas',    `gas: ${formatUsd(snap.totalGas)}`);
  setEl('kpiToday',  `${throttleState.dailyCount} / ${throttleState.dailyMax}`);
  setEl('kpiTodaySub',
        throttleState.dailyCount >= throttleState.dailyMax ? '⛔ LIMIT REACHED' : 'resets at midnight');

  const cdMs = canReb.msUntilAllowed;
  setEl('kpiCountdown', formatCountdown(cdMs),
        `kpi-value ${canReb.allowed ? 'pos' : throttleState.doublingActive ? 'dbl' : 'wrn'}`);

  setEl('kpiNet',  formatPnl(snap.netReturn), `kpi-value ${signClass(snap.netReturn)}`);
}

/**
 * Update the range bar, handles, and price marker positions in the DOM.
 * @param {number} currentPrice
 * @param {number} lowerPrice
 * @param {number} upperPrice
 */
function applyRangeBar(currentPrice, lowerPrice, upperPrice) {
  if (typeof document === 'undefined') return;
  const maxP  = upperPrice * 1.35;
  const toP   = p => `${Math.max(0, Math.min(100, (p / maxP) * 100))}%`;
  const lp    = toP(lowerPrice);
  const rp    = toP(upperPrice);
  const cp    = toP(currentPrice);
  const width = `${Math.max(0, Math.min(100, ((upperPrice - lowerPrice) / maxP) * 100))}%`;

  const ra = document.getElementById('rangeActive');
  if (ra) { ra.style.left = lp; ra.style.width = width; }
  const hl = document.getElementById('hl');
  if (hl) hl.style.left = lp;
  const hr = document.getElementById('hr');
  if (hr) hr.style.left = rp;
  const pm = document.getElementById('pm');
  if (pm) pm.style.left = cp;

  setEl('rlL',     `$${lowerPrice.toFixed(6)}`);
  setEl('rlR',     `$${upperPrice.toFixed(6)}`);
  setEl('pmlabel', `$${currentPrice.toFixed(6)}`);
  const rlLel = document.getElementById('rlL');
  if (rlLel) rlLel.style.left = lp;
  const rlRel = document.getElementById('rlR');
  if (rlRel) rlRel.style.left = rp;
}

/**
 * Update the position-type badge and wallet-strip label.
 * @param {'nft'|'erc20'|'unknown'} posType
 * @param {string} tokenIdOrContract
 */
function applyPositionType(posType, tokenIdOrContract) {
  const meta = positionTypeMeta(posType, tokenIdOrContract);
  setEl('ptBadge',       meta.badgeText,  meta.badgeClass);
  setEl('posTokenLabel', meta.stripLabel);
  setEl('wsToken',       meta.stripValue);

  const erc20sec = typeof document !== 'undefined'
    ? document.getElementById('erc20PosSection')
    : null;
  if (erc20sec) erc20sec.style.display = posType === 'erc20' ? '' : 'none';
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  formatPnl,
  formatUsd,
  formatUsd4,
  formatPct,
  formatCountdown,
  formatDuration,
  formatShortAddress,
  signClass,
  throttleBarStyle,
  rangeBannerState,
  positionTypeMeta,
  applyKpis,
  applyRangeBar,
  applyPositionType,
};
