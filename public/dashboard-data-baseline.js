/**
 * @file dashboard-data-baseline.js
 * @description HODL baseline modal: shows deposit auto-detection
 * results and prompts for manual override when prices are missing.
 * Extracted from dashboard-data-kpi.js for line-count compliance.
 */
import { g, truncName, botConfig } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import { _poolKey } from "./dashboard-data-deposit.js";
import { _fmtUsd } from "./dashboard-data-kpi.js";

function _missingPriceNames(d) {
  const a = posStore.getActive(),
    n = [];
  if (d.fetchedPrice0 !== undefined && d.fetchedPrice0 <= 0)
    n.push(truncName(a?.token0Symbol || "Token 0", 16));
  if (d.fetchedPrice1 !== undefined && d.fetchedPrice1 <= 0)
    n.push(truncName(a?.token1Symbol || "Token 1", 16));
  return n;
}

function _fillBaselineCtx() {
  const ctx = g("hodlBaselineCtx");
  if (!ctx) return;
  const a = posStore.getActive();
  if (!a) {
    ctx.textContent = "";
    return;
  }
  const w = a.walletAddress
    ? a.walletAddress.slice(0, 6) + "\u2026" + a.walletAddress.slice(-4)
    : "";
  const fee = a.fee ? " \u00B7 " + (a.fee / 10000).toFixed(2) + "% fee" : "";
  const pm = botConfig.pmName || (a.contractAddress || "").slice(0, 10);
  const pair = (a.token0Symbol || "?") + "/" + (a.token1Symbol || "?");
  ctx.innerHTML = `Blockchain: ${botConfig.chainName || "PulseChain"}<br>Wallet: ${w}<br>${pair}${pm ? " on " + pm : ""}<br>NFT #${a.tokenId}${fee}`;
}

export function _showBaselineModal(d, isFallback, isNew, curMissing, missing) {
  const amt = g("hodlBaselineAmt"),
    msg = g("hodlBaselineMsg"),
    date = g("hodlBaselineDate");
  if (!amt) return;
  _fillBaselineCtx();
  if ((isFallback || curMissing) && !isNew) {
    if (msg)
      msg.textContent =
        (missing.length
          ? "Price unavailable for " + missing.join(" and ") + ". "
          : "") + 'Use "Edit" next to Current Value to enter prices manually.';
    amt.textContent = "";
    if (date) date.textContent = "";
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || "\u2014";
  }
  const modal = g("hodlBaselineModal");
  if (modal) modal.className = "modal-overlay";
  const _setKey = (p, s) => {
    const k = _poolKey(p);
    if (k) (s || localStorage).setItem(k, "1");
  };
  const dismiss = () => {
    _setKey("9mm_hodl_acked_");
    if (isFallback) _setKey("9mm_hodl_fb_acked_");
    if (curMissing) _setKey("9mm_price_missing_acked_", sessionStorage);
    if (modal) modal.className = "modal-overlay hidden";
  };
  const ok = g("hodlBaselineOk"),
    close = g("hodlBaselineClose");
  if (ok) ok.onclick = dismiss;
  if (close) close.onclick = dismiss;
}

export function checkHodlBaselineDialog(d) {
  const _a = (p) => _poolKey(p) && !!localStorage.getItem(_poolKey(p));
  const fb = d.hodlBaselineFallback && !_a("9mm_hodl_fb_acked_");
  const isNew = d.hodlBaselineNew && d.hodlBaseline && !_a("9mm_hodl_acked_");
  const missing = _missingPriceNames(d);
  const pmk = _poolKey("9mm_price_missing_acked_");
  const cm = missing.length > 0 && !(pmk && sessionStorage.getItem(pmk));
  if (fb || isNew || cm) _showBaselineModal(d, fb, isNew, cm, missing);
}
