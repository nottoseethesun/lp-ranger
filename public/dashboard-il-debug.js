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

import { cloneTpl } from "./dashboard-helpers.js";

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
  if (!Number.isFinite(now0) || !Number.isFinite(now1)) return null;
  const frag = cloneTpl("tplIlDebugNowVsHodl");
  if (!frag) return null;
  const set = (key, val) => {
    const el = frag.querySelector(`[data-tpl="${key}"]`);
    if (el) el.textContent = val;
  };
  set("heading", "Coin Count: Now vs " + baseLabel);
  set("lblNow0", "Now " + t0sym);
  set("now0", _fmt(now0));
  set("lblBase0", baseLabel + " " + t0sym);
  set("base0", _fmt(base0));
  set("lblRatio0", t0sym + " Now / " + baseLabel);
  set("ratio0", _pct(now0, base0));
  set("lblNow1", "Now " + t1sym);
  set("now1", _fmt(now1));
  set("lblBase1", baseLabel + " " + t1sym);
  set("base1", _fmt(base1));
  set("lblRatio1", t1sym + " Now / " + baseLabel);
  set("ratio1", _pct(now1, base1));
  return frag;
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
  const frag = cloneTpl("tplIlDebugSection");
  if (!frag) return null;
  const set = (key, val) => {
    const el = frag.querySelector(`[data-tpl="${key}"]`);
    if (el) el.textContent = val;
  };
  set("heading", label);
  set("lpValue", _usd(lpValue));
  set("lblA0", "HODL " + t0sym + " deposited");
  set("a0", hasData ? _fmt(a0) : d);
  set("lblA1", "HODL " + t1sym + " deposited");
  set("a1", hasData ? _fmt(a1) : d);
  set("lblP0", "Current " + t0sym + " price");
  set("p0", hasData ? _usd(price0) : d);
  set("lblP1", "Current " + t1sym + " price");
  set("p1", hasData ? _usd(price1) : d);
  set("hodlValue", hasData ? _usd(hodlValue) : d);
  const ilCell = frag.querySelector('[data-tpl="ilResult"]');
  if (ilCell) {
    ilCell.textContent = hasData
      ? (ilResult > 0 ? "+" : "") + _usdPrecise(ilResult)
      : d;
    if (ilResult > 0) ilCell.className = "kpi-value pos";
    else if (ilResult < 0) ilCell.className = "kpi-value neg";
  }
  return frag;
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
  const frag = _buildPopoverFrag({
    isCur,
    label,
    sectionInputs,
    inputs,
    ilResult,
    t0sym,
    t1sym,
    nowVsHodl,
  });
  if (!frag) return;
  el.appendChild(frag);
  el.querySelector("[data-dismiss-il]").addEventListener(
    "click",
    dismissILDebug,
  );
  el.addEventListener("click", (e) => {
    if (e.target === el) dismissILDebug();
  });
  document.body.appendChild(el);
}

/**
 * Assemble the IL-debug popover fragment from templates.
 * Kept separate from showILDebug to keep complexity under the 17 cap.
 */
function _buildPopoverFrag(o) {
  const frag = cloneTpl("tplIlDebugPopover");
  if (!frag) return null;
  const inner = frag.querySelector('[data-tpl="inner"]');
  if (o.isCur) inner.classList.add("9mm-pos-mgr-il-popover-wide");
  const sectionFrag = _buildSection(
    o.label,
    o.sectionInputs,
    o.inputs.lpValue,
    o.inputs.price0,
    o.inputs.price1,
    o.ilResult,
    o.t0sym,
    o.t1sym,
  );
  const sectionSlot = frag.querySelector('[data-tpl="sectionSlot"]');
  if (sectionSlot && sectionFrag) sectionSlot.replaceWith(sectionFrag);
  frag.querySelector('[data-tpl="formula"]').textContent =
    "IL = LP Value \u2212 (" +
    o.t0sym +
    " deposited \u00D7 " +
    o.t0sym +
    " price + " +
    o.t1sym +
    " deposited \u00D7 " +
    o.t1sym +
    " price)";
  const nvhSlot = frag.querySelector('[data-tpl="nowVsHodlSlot"]');
  if (nvhSlot) {
    if (o.nowVsHodl) nvhSlot.replaceWith(o.nowVsHodl);
    else nvhSlot.remove();
  }
  return frag;
}

/** Remove the IL debug popover if open. */
export function dismissILDebug() {
  const el = document.getElementById("9mm-il-debug-popover");
  if (el) el.remove();
}
