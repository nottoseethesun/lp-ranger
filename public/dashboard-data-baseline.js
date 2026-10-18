/**
 * @file dashboard-data-baseline.js
 * @description HODL baseline modal: shows deposit auto-detection
 * results and prompts for manual override when prices are missing.
 * Extracted from dashboard-data-kpi.js for line-count compliance.
 */
import { g, truncName, botConfig, cloneTpl } from "./dashboard-helpers.js";
import { activeChainDisplayName } from "./dashboard-chain.js";
import { posStore } from "./dashboard-positions-store.js";
import { _poolKey } from "./dashboard-data-deposit.js";
import { _fmtUsd } from "./dashboard-fmt-usd.js";

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
  const frag = cloneTpl("tplHodlBaselineCtx");
  if (!frag) return;
  frag.querySelector('[data-tpl="chain"]').textContent =
    activeChainDisplayName();
  frag.querySelector('[data-tpl="wallet"]').textContent = w;
  frag.querySelector('[data-tpl="pair"]').textContent = pair;
  frag.querySelector('[data-tpl="pm"]').textContent = pm ? " on " + pm : "";
  frag.querySelector('[data-tpl="tokenId"]').textContent = a.tokenId;
  frag.querySelector('[data-tpl="fee"]').textContent = fee;
  ctx.replaceChildren(frag);
}

/**
 * Show one of the dialog's two messages and hide the other: the entry
 * value found, with its note, or the prices that could not be found. Each
 * has its own lines, so showing one never removes the other's.
 * @param {boolean} priceMissing  Whether the price message is the one.
 */
function _showBaselineMessage(priceMissing) {
  for (const id of ["hodlBaselineFound", "hodlBaselineFoundNote"])
    g(id)?.classList.toggle("9mm-pos-mgr-hidden", priceMissing);
  g("hodlBaselinePriceMsg")?.classList.toggle(
    "9mm-pos-mgr-hidden",
    !priceMissing,
  );
}

/**
 * Open the IL Baseline dialog with one of its two messages: the entry
 * value just found, or the coins whose prices could not be found.
 * @param {object} d             The status answer for the position.
 * @param {boolean} isFallback   The entry value could not be priced.
 * @param {boolean} isNew        The entry value was just found.
 * @param {boolean} curMissing   A coin has no current price.
 * @param {string[]} missing     The coins with no price, by name.
 */
export function _showBaselineModal(d, isFallback, isNew, curMissing, missing) {
  const amt = g("hodlBaselineAmt"),
    date = g("hodlBaselineDate");
  if (!amt) return;
  _fillBaselineCtx();
  const priceMissing = (isFallback || curMissing) && !isNew;
  if (priceMissing) {
    const msg = g("hodlBaselinePriceMsg");
    if (msg)
      msg.textContent =
        (missing.length
          ? "Price unavailable for " + missing.join(" and ") + ". "
          : "") + 'Use "Edit" next to Current Value to enter prices manually.';
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || "\u2014";
  }
  _showBaselineMessage(priceMissing);
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
