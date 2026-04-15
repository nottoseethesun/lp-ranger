/**
 * @file dashboard-il-debug.js
 * @description IL/G (Impermanent Loss/Gain) debug popover for the 9mm v3
 * Position Manager dashboard.  Shows the actual values used in the HODL
 * comparison calculation so the user can verify the IL/G result.
 *
 * The IL formula (from src/il-calculator.js):
 *   hodlValue = hodlAmount0 × currentPrice0 + hodlAmount1 × currentPrice1
 *   IL = lpValue − hodlValue
 *
 * Two IL values are shown:
 *   - **Current position** (totalIL): uses baseline deposited amounts from
 *     the IncreaseLiquidity event on the current NFT's mint TX.
 *   - **Lifetime** (lifetimeIL): uses deposited amounts from the first
 *     epoch in the rebalance chain (original entry point).
 *
 * Depends on: dashboard-helpers.js (g).
 */

/** @type {object|null} Latest snapshot data from the polling loop. */
let _lastData = null;
let _posStore = null;

/**
 * Store the latest /api/status data for popover rendering.
 * Called from dashboard-data.js on every poll.
 * @param {object} data  Parsed /api/status response.
 * @param {object} [posStore]  Position store (for token symbols).
 */
export function updateILDebugData(data, posStore) {
  _lastData = data;
  if (posStore) _posStore = posStore;
}

/** Format a number for display (up to 6 decimals, trim trailing zeros). */
function _fmt(v, decimals = 6) {
  if (v === null || v === undefined) return "\u2014";
  return Number(v)
    .toFixed(decimals)
    .replace(/\.?0+$/, "");
}

/** Format USD value — scientific notation for very small prices. */
function _usd(v) {
  if (v === null || v === undefined) return "\u2014";
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.01) return "$" + abs.toExponential();
  return (v < 0 ? "-" : "") + "$" + abs.toFixed(2);
}

/** Format USD to nearest hundredth of a cent (4 decimal places). */
function _usdPrecise(v) {
  if (v === null || v === undefined) return "\u2014";
  const abs = Math.abs(v);
  return (v < 0 ? "-" : "") + "$" + abs.toFixed(4);
}

/** Format a percentage with 2 decimals; em-dash for invalid. */
function _pct(now, hodl) {
  if (!Number.isFinite(now) || !Number.isFinite(hodl) || hodl <= 0)
    return "\u2014";
  return (100 * (now / hodl)).toFixed(2) + "%";
}

/**
 * Build the "Coin Count: Now vs <baseline>" comparison block. Shows current
 * LP token amounts and what percentage they represent of the baseline
 * (Initial Deposit for the current NFT, or HODL for lifetime). Marked off by
 * a subtle gray divider line above and below.
 *
 * @param {number} now0       Current LP amount of token0.
 * @param {number} now1       Current LP amount of token1.
 * @param {number} base0      Baseline deposited amount of token0.
 * @param {number} base1      Baseline deposited amount of token1.
 * @param {string} t0sym      Token0 symbol.
 * @param {string} t1sym      Token1 symbol.
 * @param {string} baseLabel  Baseline label ("HODL" or "Initial Deposit for This LP").
 * @returns {string} HTML string (empty if no current amounts).
 */
function _buildNowVsHodl(now0, now1, base0, base1, t0sym, t1sym, baseLabel) {
  if (!Number.isFinite(now0) || !Number.isFinite(now1)) return "";
  return `<div class="9mm-pos-mgr-il-now-vs-hodl">
    <div class="9mm-pos-mgr-il-heading">Coin Count: Now vs ${baseLabel}</div>
    <table class="9mm-pos-mgr-il-table">
      <tr><td>Now ${t0sym}</td><td>${_fmt(now0)}</td></tr>
      <tr><td>${baseLabel} ${t0sym}</td><td>${_fmt(base0)}</td></tr>
      <tr class="9mm-pos-mgr-il-result"><td>${t0sym} Now / ${baseLabel}</td><td>${_pct(now0, base0)}</td></tr>
      <tr class="9mm-pos-mgr-il-sep"><td>Now ${t1sym}</td><td>${_fmt(now1)}</td></tr>
      <tr><td>${baseLabel} ${t1sym}</td><td>${_fmt(base1)}</td></tr>
      <tr class="9mm-pos-mgr-il-result"><td>${t1sym} Now / ${baseLabel}</td><td>${_pct(now1, base1)}</td></tr>
    </table>
  </div>`;
}

/**
 * Build the HTML content for one IL calculation section.
 * @param {string} label       Section heading.
 * @param {object} inputs      { hodlAmount0, hodlAmount1 } for this section.
 * @param {number} lpValue     Current LP position value (USD).
 * @param {number} price0      Current token0 USD price.
 * @param {number} price1      Current token1 USD price.
 * @param {number|null} ilResult  Computed IL value.
 * @param {string} t0sym       Token0 symbol.
 * @param {string} t1sym       Token1 symbol.
 * @returns {string} HTML string.
 */
function _buildSection(
  label,
  inputs,
  lpValue,
  price0,
  price1,
  ilResult,
  t0sym,
  t1sym,
) {
  const a0 = inputs?.hodlAmount0,
    a1 = inputs?.hodlAmount1;
  const hasData = a0 > 0 || a1 > 0;
  const d = "\u2014";
  const hodlValue = hasData ? a0 * price0 + a1 * price1 : 0;
  const ilCls =
    ilResult > 0 ? "kpi-value pos" : ilResult < 0 ? "kpi-value neg" : "";
  return `<div class="9mm-pos-mgr-il-section">
    <div class="9mm-pos-mgr-il-heading">${label}</div>
    <table class="9mm-pos-mgr-il-table">
      <tr><td>LP Value (on-chain)</td><td>${_usd(lpValue)}</td></tr>
      <tr><td>HODL ${t0sym} deposited</td><td>${hasData ? _fmt(a0) : d}</td></tr>
      <tr><td>HODL ${t1sym} deposited</td><td>${hasData ? _fmt(a1) : d}</td></tr>
      <tr><td>Current ${t0sym} price</td><td>${hasData ? _usd(price0) : d}</td></tr>
      <tr><td>Current ${t1sym} price</td><td>${hasData ? _usd(price1) : d}</td></tr>
      <tr class="9mm-pos-mgr-il-sep"><td>HODL value</td><td>${hasData ? _usd(hodlValue) : d}</td></tr>
      <tr class="9mm-pos-mgr-il-result"><td>IL/G (LP \u2212 HODL)</td>
        <td class="${ilCls}">${hasData ? (ilResult > 0 ? "+" : "") + _usdPrecise(ilResult) : d}</td></tr>
    </table>
  </div>`;
}

/** Resolve token symbols from posStore (has symbols) or activePosition (addresses only). */
function _tokenSymbols() {
  const p = _posStore?.getActive();
  const a = _lastData?.activePosition;
  return {
    t0:
      p?.token0Symbol || a?.token0Symbol || a?.token0?.slice(0, 6) || "Token0",
    t1:
      p?.token1Symbol || a?.token1Symbol || a?.token1?.slice(0, 6) || "Token1",
  };
}

/**
 * Show the IL debug popover near the clicked info icon.
 * @param {'cur'|'lt'} panel  Which panel's icon was clicked.
 */
export function showILDebug(panel) {
  dismissILDebug();
  const snap = _lastData?.pnlSnapshot;
  const inputs = snap?.ilInputs;
  if (!inputs) return;

  const { t0: t0sym, t1: t1sym } = _tokenSymbols();
  const isCur = panel === "cur";
  const sectionInputs = isCur ? inputs.cur : inputs.lt;
  const ilResult = isCur ? snap.totalIL : snap.lifetimeIL;
  const label = isCur ? "Current Position IL/G" : "Lifetime IL/G";

  const ps = _lastData?.positionStats;
  const now0 = ps?.balance0 !== undefined ? Number(ps.balance0) : NaN;
  const now1 = ps?.balance1 !== undefined ? Number(ps.balance1) : NaN;
  const baseLabel = isCur ? "Initial Deposit for This LP" : "HODL";
  const nowVsHodl = _buildNowVsHodl(
    now0,
    now1,
    sectionInputs?.hodlAmount0,
    sectionInputs?.hodlAmount1,
    t0sym,
    t1sym,
    baseLabel,
  );

  const el = document.createElement("div");
  el.className = "9mm-pos-mgr-il-popover";
  el.id = "9mm-il-debug-popover";
  const innerCls = isCur
    ? "9mm-pos-mgr-il-popover-inner 9mm-pos-mgr-il-popover-wide"
    : "9mm-pos-mgr-il-popover-inner";
  el.innerHTML = `<div class="${innerCls}">
    ${_buildSection(label, sectionInputs, inputs.lpValue, inputs.price0, inputs.price1, ilResult, t0sym, t1sym)}
    <div class="9mm-pos-mgr-il-formula">IL = LP Value \u2212 (${t0sym} deposited \u00D7 ${t0sym} price + ${t1sym} deposited \u00D7 ${t1sym} price)</div>
    ${nowVsHodl}
    <button class="9mm-pos-mgr-il-ok-btn" data-dismiss-il>Close</button>
  </div>`;
  el.querySelector("[data-dismiss-il]").addEventListener(
    "click",
    dismissILDebug,
  );
  el.addEventListener("click", (e) => {
    if (e.target === el) dismissILDebug();
  });
  document.body.appendChild(el);
}

/** Remove the IL debug popover if open. */
export function dismissILDebug() {
  const el = document.getElementById("9mm-il-debug-popover");
  if (el) el.remove();
}
