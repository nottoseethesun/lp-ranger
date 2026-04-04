/**
 * @file dashboard-data-kpi.js
 * @description KPI calculation and display for the
 * 9mm v3 Position Manager dashboard.
 * Split from dashboard-data.js.
 */
import {
  g, truncName, fmtDateTime, botConfig,
  fmtNum, isFullRange,
} from './dashboard-helpers.js';
import { posStore } from './dashboard-positions.js';
import {
  _poolKey, loadRealizedGains, loadCurRealized,
  loadInitialDeposit, loadCurDeposit,
  refreshCurDepositDisplay,
} from './dashboard-data-deposit.js';

let _poolFirstDate = null;
export function setPoolFirstDate(d) { _poolFirstDate = d; }
export function getPoolFirstDate() { return _poolFirstDate; }

/** Format a number as USD. */
export function _fmtUsd(val) {
  if (val === null || val === undefined || isNaN(val)) return '\u2014';
  const abs = Math.abs(val).toFixed(2);
  return abs === '0.00'
    ? '$usd 0.00'
    : (val < 0 ? '-' : '') + '$usd ' + abs;
}
export function _isDisplayZero(val) {
  return Math.abs(val).toFixed(2) === '0.00';
}
export function _setPctSpan(id, val, deposit) {
  const el = g(id);
  if (!el) return;
  if (!deposit || deposit <= 0) { el.textContent = ''; return; }
  const pct = (val / deposit) * 100, r = pct.toFixed(2),
    z = r === '0.00' || r === '-0.00';
  el.textContent = (z ? '' : pct > 0 ? '+' : '') + (z ? '0.00' : r) + '%';
}
export function _setAprSpan(id, val, deposit, firstDate) {
  const el = g(id);
  if (!el) return;
  if (!deposit || deposit <= 0 || !firstDate) {
    el.textContent = '\u2014'; return;
  }
  const sec =
    (Date.now() - new Date(firstDate + 'T00:00:00Z').getTime()) / 1000;
  if (sec <= 0) { el.textContent = '\u2014'; return; }
  const apr = (val / deposit / (sec / (365.25 * 86400))) * 100;
  if (Math.abs(apr) < 0.005) {
    el.textContent = 'APR 0.00%'; el.style.color = ''; return;
  }
  el.textContent =
    (apr > 0 ? 'APR ' + apr.toFixed(2)
      : 'APR \u2212' + Math.abs(apr).toFixed(2)) + '%';
  el.style.color = apr > 0 ? '#0f0' : '#f44';
}
export function _setLeadingText(el, text) {
  if (!el) return;
  if (el.firstChild?.nodeType === 3) el.firstChild.textContent = text;
  else el.insertBefore(document.createTextNode(text), el.firstChild);
}
/** Reset KPIs to dashes. */
export function resetKpis(ids) {
  for (const id of ids) {
    const el = g(id);
    if (el) { el.textContent = '\u2014'; el.className = 'kpi-value neu'; }
  }
}
export function _resetCurrentKpis() {
  resetKpis([
    'kpiValue', 'kpiDeposit', 'pnlFees',
    'pnlPrice', 'pnlRealized', 'curProfit', 'curIL',
  ]);
}
/** Set KPI with USD value and sign-colored class. */
export function setKpiValue(id, val) {
  const el = g(id);
  if (!el) return;
  if (val === null || val === undefined) {
    el.textContent = '\u2014'; el.className = 'kpi-value neu'; return;
  }
  const cls = _isDisplayZero(val) ? 'neu' : val > 0 ? 'pos' : 'neg';
  el.textContent = _fmtUsd(val);
  el.className = el.className
    .replace(/\b(pos|neg|neu)\b/g, '').replace(/\bkpi-value\b/, '').trim();
  el.classList.add('kpi-value', cls);
}
export function _updatePnlHeader(d, total, realized, curDeposit) {
  const pnl = g('kpiPnl'), pnlSub = g('kpiPnlPct');
  if (d.pnlSnapshot) {
    _setLeadingText(pnl, _fmtUsd(total));
    pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' +
      (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiPnlPctVal', total, curDeposit);
    const posStart = d.hodlBaseline?.mintDate || null;
    _setAprSpan('kpiPnlApr', total, curDeposit, posStart);
    if (posStart) {
      pnlSub.textContent =
        fmtDateTime(posStart + 'T00:00:00Z', { dateOnly: true }) +
        ' \u2192 ' +
        fmtDateTime(d.pnlSnapshot.snapshotDateUtc + 'T00:00:00Z', {
          dateOnly: true,
        });
    } else pnlSub.textContent = 'cumulative';
  } else if (d.running) {
    if (realized > 0) {
      _setLeadingText(pnl, _fmtUsd(realized));
      pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row pos';
    }
    pnlSub.textContent = 'Awaiting First P\u0026L Snapshot';
  }
}
/** Format a duration in ms as "Xd Yh Zm". */
export function _fmtDuration(ms) {
  const d = Math.floor(ms / 86400000),
    h = Math.floor((ms % 86400000) / 3600000),
    m = Math.floor((ms % 3600000) / 60000);
  return (d > 0 ? d + 'd ' : '') +
    (h > 0 || d > 0 ? h + 'h ' : '') + m + 'm';
}
export function _updateCurIL(d, deposit) {
  const raw = d.pnlSnapshot
    ? d.pnlSnapshot.totalIL : undefined;
  const el = g('curIL');
  if (el) {
    if (raw === null || raw === undefined) {
      _setLeadingText(el, '\u2014');
      el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu';
    } else {
      _setLeadingText(el, _fmtUsd(raw));
      el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' +
        (_isDisplayZero(raw) ? 'neu' : raw > 0 ? 'pos' : 'neg');
    }
  }
  _setPctSpan('curILPct', raw ?? 0, deposit);
}
export function _updatePosDuration(d) {
  const el = g('kpiPosDuration');
  if (!el) return;
  const mt = d.positionMintTimestamp ||
    d.hodlBaseline?.mintTimestamp || d.hodlBaseline?.mintDate;
  if (!mt) { el.textContent = '\u2014'; return; }
  const ms = Date.now() -
    (mt.includes('T') ? new Date(mt).getTime()
      : new Date(mt + 'T00:00:00Z').getTime());
  el.textContent = ms > 0
    ? 'Active: ' + _fmtDuration(ms) + ' \u00B7 Minted: ' + fmtDateTime(mt)
    : '';
}
export function _applySnapshotKpis(d, deposit, curRealized) {
  const ep = d.pnlSnapshot.liveEpoch, cv = d.pnlSnapshot.currentValue || 0;
  const val = g('kpiValue');
  if (val) val.textContent = _fmtUsd(cv);
  setKpiValue('pnlFees', ep ? ep.fees || 0 : 0);
  setKpiValue('pnlPrice', deposit > 0 ? cv - deposit : 0);
  setKpiValue('pnlRealized', curRealized);
  const dep = g('kpiDeposit');
  if (dep) dep.textContent = _fmtUsd(deposit);
  _updateCurIL(d, deposit);
  _updatePosDuration(d);
  _setProfitKpi('curProfit', ep ? ep.fees || 0 : 0,
    ep ? ep.gas || 0 : 0, d.pnlSnapshot.totalIL);
}
export function _botDetectedDeposit(d) {
  if (d.initialDepositUsd > 0) return d.initialDepositUsd;
  if (d.hodlBaseline?.entryValue > 0) return d.hodlBaseline.entryValue;
  return d.pnlSnapshot ? d.pnlSnapshot.initialDeposit || 0 : 0;
}
export function _resolveCurDeposit(d) {
  const saved = loadCurDeposit();
  if (saved > 0) return saved;
  return d.hodlBaseline?.entryValue > 0
    ? d.hodlBaseline.entryValue
    : d.pnlSnapshot?.liveEpoch?.entryValue || 0;
}
export function _priceChangePnl(d, deposit) {
  return d.pnlSnapshot && deposit > 0
    ? (d.pnlSnapshot.currentValue || 0) - deposit : 0;
}
export function _resolveKpiTotals(d) {
  const ltRealized = loadRealizedGains(), curRealized = loadCurRealized();
  const ltFees = d.pnlSnapshot ? d.pnlSnapshot.totalFees || 0 : 0;
  const curFees = d.pnlSnapshot?.liveEpoch?.fees || 0;
  const curDep = _resolveCurDeposit(d), ltUserDep = loadInitialDeposit();
  const ltDep = ltUserDep > 0 ? ltUserDep : _botDetectedDeposit(d);
  const curPc = _priceChangePnl(d, curDep),
    ltPc = _priceChangePnl(d, ltDep);
  return {
    curTotal: curPc + curFees + curRealized,
    ltTotal: ltPc + ltFees + ltRealized,
    curDep, ltDep, curRealized, ltFees, ltRealized, ltPriceChange: ltPc,
  };
}
export function _setDepositDisplay(dep) {
  const dd = g('lifetimeDepositDisplay'), dl = g('initialDepositLabel');
  if (dd) dd.textContent = dep > 0 ? '$usd ' + dep.toFixed(2) : '\u2014';
  if (dl) dl.textContent = dep > 0
    ? 'Initial Deposit: $' + dep.toFixed(2) : 'Edit Initial Deposit';
}
export function _updateLifetimeKpis(d) {
  if (!posStore.getActive() || !d.pnlSnapshot ||
    (d.running && !d.rebalanceScanComplete)) return;
  const t = _resolveKpiTotals(d);
  _updateNetReturn(d, t.ltTotal, t.ltDep, t.ltFees, t.ltPriceChange,
    t.ltRealized);
  _setDepositDisplay(t.ltDep);
}
export function _updateKpis(d) {
  if (!posStore.getActive()) return;
  const t = _resolveKpiTotals(d);
  _updatePnlHeader(d, t.curTotal, t.curRealized, t.curDep);
  if (d.pnlSnapshot) _applySnapshotKpis(d, t.curDep, t.curRealized);
  else if (d.running) _resetCurrentKpis();
  if (d.pnlSnapshot) {
    if (!d.running || d.rebalanceScanComplete) {
      _updateNetReturn(d, t.ltTotal, t.ltDep, t.ltFees, t.ltPriceChange,
        t.ltRealized);
      _setDepositDisplay(t.ltDep);
    }
    refreshCurDepositDisplay(
      d.hodlBaseline?.entryValue ||
        d.pnlSnapshot.liveEpoch?.entryValue || 0);
  }
}
export function _updateNetBreakdown(bd, fees, priceChange, realized) {
  if (fees === undefined && priceChange === undefined) {
    bd.textContent = '\u2014'; return;
  }
  const f = (fees || 0).toFixed(2), p = priceChange || 0,
    r = (realized || 0).toFixed(2);
  bd.textContent = f + (p >= 0 ? ' + ' : ' \u2212 ') +
    Math.abs(p).toFixed(2) + ' + ' + r;
}
export function _setProfitKpi(id, fees, gas, ilg) {
  const el = g(id);
  if (!el) return;
  if (ilg === null || ilg === undefined) {
    _setLeadingText(el, '\u2014');
    el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu'; return;
  }
  const p = (fees || 0) - (gas || 0) + ilg;
  _setLeadingText(el, _fmtUsd(p));
  el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' +
    (_isDisplayZero(p) ? 'neu' : p > 0 ? 'pos' : 'neg');
}
export function _ltStartDate(d) {
  return d.pnlSnapshot?.firstEpochDateUtc ||
    d.hodlBaseline?.mintDate || _poolFirstDate;
}
export function _updateIL(d, ltDeposit) {
  const il = d.pnlSnapshot
    ? (d.pnlSnapshot.lifetimeIL ?? d.pnlSnapshot.totalIL ?? null) : null;
  const ilEl = g('netIL');
  if (!ilEl || !d.pnlSnapshot) return il;
  if (il === null) {
    _setLeadingText(ilEl, '\u2014');
    ilEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu';
  } else {
    _setLeadingText(ilEl, _fmtUsd(il));
    ilEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' +
      (_isDisplayZero(il) ? 'neu' : il > 0 ? 'pos' : 'neg');
    _setPctSpan('netILPct', il, ltDeposit);
    _setAprSpan('netILApr', il, ltDeposit, _ltStartDate(d));
  }
  return il;
}
export function _updateNetReturn(
  d, total, ltDeposit, ltFees, ltPriceChange, ltRealized,
) {
  const net = g('kpiNet');
  if (d.pnlSnapshot) {
    _setLeadingText(net, _fmtUsd(total));
    net.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' +
      (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiNetPct', total, ltDeposit);
    _setAprSpan('kpiNetApr', total, ltDeposit, _ltStartDate(d));
    const _ll = g('ltPnlLabel'), _sd = _ltStartDate(d);
    if (_ll)
      _ll.textContent = _sd
        ? 'Net Profit and Loss Return Over ' +
          ((Date.now() - new Date(_sd + 'T00:00:00Z').getTime()) /
            86400000).toFixed(2) + ' Days'
        : 'Net Profit and Loss Return';
    const bd = g('kpiNetBreakdown');
    if (bd) _updateNetBreakdown(bd, ltFees, ltPriceChange, ltRealized);
  }
  const il = _updateIL(d, ltDeposit);
  _setProfitKpi('ltProfit', ltFees, d.pnlSnapshot?.totalGas || 0, il);
}
export function _missingPriceNames(d) {
  const a = posStore.getActive(), n = [];
  if (d.fetchedPrice0 !== undefined && d.fetchedPrice0 <= 0)
    n.push(truncName(a?.token0Symbol || 'Token 0', 16));
  if (d.fetchedPrice1 !== undefined && d.fetchedPrice1 <= 0)
    n.push(truncName(a?.token1Symbol || 'Token 1', 16));
  return n;
}
function _fillBaselineCtx() {
  const ctx = g('hodlBaselineCtx'); if (!ctx) return;
  const a = posStore.getActive();
  if (!a) { ctx.textContent = ''; return; }
  const pair = (a.token0Symbol || '?') + '/' + (a.token1Symbol || '?');
  const chain = botConfig.chainName || 'PulseChain';
  const pm = botConfig.pmName || (a.contractAddress || '').slice(0, 10);
  const w = a.walletAddress
    ? a.walletAddress.slice(0, 6) + '\u2026' + a.walletAddress.slice(-4) : '';
  const fee = a.fee ? (a.fee / 10000).toFixed(2) + '% fee' : '';
  const _br = () => ctx.appendChild(document.createElement('br'));
  const _t = (s) => ctx.appendChild(document.createTextNode(s));
  ctx.textContent = 'Blockchain: ' + chain; _br();
  _t('Wallet: ' + w); _br();
  _t(pair + (pm ? ' on ' + pm : '')); _br();
  _t('NFT #' + a.tokenId + (fee ? ' \u00B7 ' + fee : ''));
}
export function _showBaselineModal(
  d, isFallback, isNew, curMissing, missing,
) {
  const amt = g('hodlBaselineAmt'), msg = g('hodlBaselineMsg'),
    date = g('hodlBaselineDate');
  if (!amt) return;
  _fillBaselineCtx();
  if ((isFallback || curMissing) && !isNew) {
    if (msg)
      msg.textContent = (missing.length
        ? 'Price unavailable for ' + missing.join(' and ') + '. ' : '') +
        'Use "Edit" next to Current Value to enter prices manually.';
    amt.textContent = '';
    if (date) date.textContent = '';
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || '\u2014';
  }
  const modal = g('hodlBaselineModal');
  if (modal) modal.className = 'modal-overlay';
  const dismiss = () => {
    const bk = _poolKey('9mm_hodl_acked_');
    if (bk) localStorage.setItem(bk, '1');
    if (isFallback) {
      const fk = _poolKey('9mm_hodl_fb_acked_');
      if (fk) localStorage.setItem(fk, '1');
    }
    if (curMissing) {
      const pk = _poolKey('9mm_price_missing_acked_');
      if (pk) sessionStorage.setItem(pk, '1');
    }
    if (modal) modal.className = 'modal-overlay hidden';
  };
  const ok = g('hodlBaselineOk'); if (ok) ok.onclick = dismiss;
  const close = g('hodlBaselineClose'); if (close) close.onclick = dismiss;
}
function _poolAcked(p) {
  const k = _poolKey(p);
  return k && !!localStorage.getItem(k);
}
export function checkHodlBaselineDialog(d) {
  const fb = d.hodlBaselineFallback
    && !_poolAcked('9mm_hodl_fb_acked_');
  const isNew = d.hodlBaselineNew
    && d.hodlBaseline && !_poolAcked('9mm_hodl_acked_');
  const missing = _missingPriceNames(d);
  const pmk = _poolKey('9mm_price_missing_acked_');
  const cm = missing.length > 0
    && !(pmk && sessionStorage.getItem(pmk));
  if (fb || isNew || cm)
    _showBaselineModal(d, fb, isNew, cm, missing);
}
export function _activeToken1Symbol() {
  const a = posStore.getActive();
  return truncName(
    a ? a.token1Symbol || '?' : '?', 12);
}
function _showFullRange() {
  const s = _activeToken1Symbol(),
    _h = (id) => {
      const e = g(id);
      if (e) e.style.display = 'none';
    };
  const ra = g('rangeActive');
  if (ra) { ra.style.left = '2%'; ra.style.width = '96%'; }
  _h('hl'); _h('hr'); _h('rangeLnL'); _h('rangeLnR');
  _h('rangeStartLabel'); _h('rangeEndLabel'); _h('rlL'); _h('rlR');
  const rv = document.querySelector('.range-visual');
  if (rv) { rv.style.overflow = 'visible'; rv.style.marginBottom = '0'; }
  const fr = g('fullRangeLabels'); if (fr) fr.hidden = false;
  const pm = g('pm');
  if (pm && botConfig.price > 0)
    { pm.style.left = '50%'; pm.style.visibility = 'visible'; }
  const pml = g('pmlabel');
  if (pml) { pml.textContent = fmtNum(botConfig.price) + ' ' + s;
    pml.title = String(botConfig.price); }
  ['rangePctLower', 'rangePctUpper'].forEach(
    (id) => {
      const e = g(id);
      if (e) e.textContent = 'Full range';
    });
}
/** Position range bar, handles, price marker. */
export function positionRangeVisual() {
  const lo = botConfig.lower,
    hi = botConfig.upper;
  if (!lo || !hi || lo >= hi) return;
  if (isFullRange(lo, hi)) {
    _showFullRange(); return;
  }
  ['hl', 'hr', 'rangeLnL', 'rangeLnR',
    'rlL', 'rlR'].forEach((id) => {
    const e = g(id);
    if (e) {
      e.style.display = '';
      e.style.visibility = '';
      e.style.transform = '';
    }
  });
  ['rangeStartLabel', 'rangeEndLabel',
    'fullRangeLabels'].forEach((id) => {
    const e = g(id);
    if (e) {
      e.style.display = 'none';
      if (e.hidden !== undefined)
        e.hidden = true;
    }
  });
  const _rv = document.querySelector(
    '.range-visual');
  if (_rv) {
    _rv.style.overflow = '';
    _rv.style.marginBottom = '';
  }
  const threshPct =
    (botConfig.oorThreshold || 5) / 100;
  const rangeSpan = hi - lo;
  const previewLo = lo - rangeSpan * threshPct;
  const previewHi = hi + rangeSpan * threshPct;
  const pad = rangeSpan *
    Math.max(0.6, threshPct * 1.5);
  const vMin = Math.max(0, lo - pad),
    vMax = hi + pad, vSpan = vMax - vMin;
  const pct = (p) =>
    (((p - vMin) / vSpan) * 100).toFixed(2) +
    '%';
  const ra = g('rangeActive');
  if (ra) {
    ra.style.left = pct(lo);
    ra.style.width =
      (((hi - lo) / vSpan) * 100).toFixed(2) +
      '%';
  }
  const hl = g('hl'), hr = g('hr');
  if (hl) hl.style.left = pct(lo);
  if (hr) hr.style.left = pct(hi);
  const rsym = _activeToken1Symbol(),
    rlL = g('rlL'), rlR = g('rlR');
  if (rlL) {
    rlL.style.left = pct(lo);
    rlL.textContent =
      fmtNum(lo) + ' ' + rsym;
    rlL.title = lo.toString() + ' ' + rsym;
  }
  if (rlR) {
    rlR.style.left = pct(hi);
    rlR.textContent =
      fmtNum(hi) + ' ' + rsym;
    rlR.title = hi.toString() + ' ' + rsym;
  }
  const pm = g('pm');
  if (pm && botConfig.price > 0) {
    pm.style.left = pct(botConfig.price);
    pm.style.visibility = 'visible';
  }
  const lnL = g('rangeLnL'),
    lnR = g('rangeLnR'),
    rsym2 = _activeToken1Symbol();
  if (lnL) {
    lnL.style.left = pct(previewLo);
    lnL.title =
      'Rebalance trigger: ' +
      fmtNum(previewLo) + ' ' + rsym2 +
      ' (' + botConfig.oorThreshold +
      '% below lower)';
  }
  if (lnR) {
    lnR.style.left = pct(previewHi);
    lnR.title =
      'Rebalance trigger: ' +
      fmtNum(previewHi) + ' ' + rsym2 +
      ' (' + botConfig.oorThreshold +
      '% above upper)';
  }
}
export function updateRangePctLabels(
  price, lower, upper,
) {
  const lo = g('rangePctLower'),
    hi = g('rangePctUpper');
  if (!lo || !hi || !price || price <= 0) return;
  if (isFullRange(lower, upper)) {
    lo.textContent = 'Full range';
    hi.textContent = 'Full range';
    return;
  }
  const loPct =
    ((lower - price) / price) * 100,
    hiPct = ((upper - price) / price) * 100;
  lo.textContent =
    loPct.toFixed(3) + '% below price';
  lo.title = loPct.toString() + '%';
  hi.textContent =
    '+' + hiPct.toFixed(3) + '% above price';
  hi.title = '+' + hiPct.toString() + '%';
}
