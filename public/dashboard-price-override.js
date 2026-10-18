/**
 * @file dashboard-price-override.js
 * @description Manual token price override for positions where auto-detection
 *   fails. Prices persist to pool-scoped localStorage and are sent as fallbacks
 *   in detail requests. Non-zero fetched prices automatically replace overrides.
 */

import { g, truncName, compositeKey } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions-store.js";
import { _posContextHtml } from "./dashboard-data-status.js";
import { saveConfigValues } from "./dashboard-config-save.js";
import { activeChainId } from "./dashboard-chain.js";
import { _poolKey } from "./dashboard-data-deposit.js";

let _refetchUnmanaged = null;
/** Inject re-fetch callback (avoids circular import). */
export function injectPriceOverrideDeps(deps) {
  if (deps.refetchUnmanaged) _refetchUnmanaged = deps.refetchUnmanaged;
}

/**
 * Pool-scoped localStorage key for price overrides: the chain, wallet,
 * contract, both tokens and the fee, so the same pair elsewhere never
 * shares the override. Null until the chain is known.
 */
function _overrideKey() {
  return _poolKey("9mm_price_override_");
}

/** Last known fetched prices (for dialog pre-population). */
let _lastPrices = { price0: 0, price1: 0 };
export function setLastPrices(p0, p1) {
  _lastPrices = { price0: p0, price1: p1 };
}

/** Load user-entered price overrides. Returns { price0, price1 }. */
export function loadPriceOverrides() {
  const k = _overrideKey();
  if (!k) return { price0: 0, price1: 0 };
  try {
    const j = JSON.parse(localStorage.getItem(k));
    return { price0: j?.price0 || 0, price1: j?.price1 || 0 };
  } catch {
    return { price0: 0, price1: 0 };
  }
}

/**
 * Save price overrides to pool-scoped localStorage.
 * @param {number} p0
 * @param {number} p1
 * @param {string|null} [k]  The pool's key; the one on screen unless the
 *   caller fixed it when the operator saved.
 */
function _save(p0, p1, k = _overrideKey()) {
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify({ price0: p0, price1: p1 }));
  } catch {
    /* */
  }
}
/** Load the force-override flag (pool-scoped). */
export function loadForceOverride() {
  const k = _overrideKey();
  return k ? localStorage.getItem(k + "_force") === "1" : false;
}
function _loadForce() {
  return loadForceOverride();
}
function _saveForce(v, k = _overrideKey()) {
  if (k) {
    if (v) localStorage.setItem(k + "_force", "1");
    else localStorage.removeItem(k + "_force");
  }
}

/** Clear override for a token whose fetched price returned non-zero (skipped in force mode). */
export function clearPriceOverrideIfFetched(p0, p1) {
  if (_loadForce()) return;
  const ov = loadPriceOverrides();
  let changed = false;
  if (p0 > 0 && ov.price0 > 0) {
    ov.price0 = 0;
    changed = true;
  }
  if (p1 > 0 && ov.price1 > 0) {
    ov.price1 = 0;
    changed = true;
  }
  if (changed) _save(ov.price0, ov.price1);
}

/** Open the price override dialog, pre-populated with current prices. */
export function openPriceOverrideDialog() {
  const active = posStore.getActive();
  if (!active) return;
  const ov = loadPriceOverrides();
  const i0 = g("priceOverrideInput0"),
    i1 = g("priceOverrideInput1");
  if (i0) i0.value = ov.price0 > 0 ? ov.price0 : _lastPrices.price0 || "";
  if (i1) i1.value = ov.price1 > 0 ? ov.price1 : _lastPrices.price1 || "";
  const l0 = g("priceOverrideLabel0"),
    l1 = g("priceOverrideLabel1");
  if (l0) l0.textContent = truncName(active.token0Symbol || "Token 0", 20);
  if (l1) l1.textContent = truncName(active.token1Symbol || "Token 1", 20);
  /*- Populate the pool-identity header so users always know which pool
   *  these prices apply to (provider, pair, fee tier, NFT, chain, wallet). */
  const ctx = g("priceOverrideCtx");
  if (ctx) ctx.innerHTML = _posContextHtml();
  const fc = g("priceOverrideForce");
  if (fc) fc.checked = _loadForce();
  const m = g("priceOverrideModal");
  if (m) m.classList.remove("hidden");
}

/** Save prices from the dialog and trigger re-fetch. */
export function savePriceOverrideDialog() {
  const i0 = g("priceOverrideInput0"),
    i1 = g("priceOverrideInput1");
  const p0 = parseFloat(i0?.value) || 0,
    p1 = parseFloat(i1?.value) || 0;
  const fc = g("priceOverrideForce");
  const force = fc ? fc.checked : false;
  const m = g("priceOverrideModal");
  if (m) m.classList.add("hidden");
  const active = posStore.getActive();
  if (!active) {
    /*- No position to save against, so the browser copy is all there
     *  is. */
    _save(p0, p1);
    _saveForce(force);
    return;
  }
  const chain = activeChainId();
  const pk = compositeKey(
    chain,
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  // The pool saved for, fixed now: the screen may move before the answer.
  const ovKey = _overrideKey();
  saveConfigValues({
    values: {
      priceOverride0: p0,
      priceOverride1: p1,
      priceOverrideForce: force,
    },
    positionKey: pk,
    inputs: {
      priceOverride0: "priceOverrideInput0",
      priceOverride1: "priceOverrideInput1",
    },
    onSaved: (onScreen) =>
      _afterPriceSaved({ p0, p1, force, ovKey, active, onScreen }),
  });
}

/**
 * What a price override the server took does in the browser.
 *
 * The browser copy is written only once the server has taken the
 * prices. Written first, a refused price would still be the one the KPI
 * panel valued the position at — the panel reads localStorage, and
 * nothing later corrects it. It goes under the pool saved for, fixed
 * when the operator saved, since the answer can come after a move to
 * another position. The refetch of the position's figures is for the
 * screen, so it waits for the answer to be about the position on it.
 *
 * Exported so a test can drive it: the request goes through the global
 * `fetch`, which a test must not replace.
 *
 * @param {object} o
 * @param {number} o.p0
 * @param {number} o.p1
 * @param {boolean} o.force
 * @param {string|null} o.ovKey  The pool's browser key, fixed at save.
 * @param {object} o.active      The position saved for.
 * @param {boolean} o.onScreen   Whether it is still the one on screen.
 */
export function _afterPriceSaved({ p0, p1, force, ovKey, active, onScreen }) {
  _save(p0, p1, ovKey);
  _saveForce(force, ovKey);
  if (onScreen && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
}

/** Close the price override dialog without saving. */
export function closePriceOverrideDialog() {
  const m = g("priceOverrideModal");
  if (m) m.classList.add("hidden");
}
