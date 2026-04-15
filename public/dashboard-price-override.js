/**
 * @file dashboard-price-override.js
 * @description Manual token price override for positions where auto-detection
 *   fails. Prices persist to pool-scoped localStorage and are sent as fallbacks
 *   in detail requests. Non-zero fetched prices automatically replace overrides.
 */

import {
  g,
  truncName,
  compositeKey,
  csrfHeaders,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";

let _refetchUnmanaged = null;
/** Inject re-fetch callback (avoids circular import). */
export function injectPriceOverrideDeps(deps) {
  if (deps.refetchUnmanaged) _refetchUnmanaged = deps.refetchUnmanaged;
}

/** Pool-scoped localStorage key for price overrides. */
function _overrideKey() {
  const a = posStore.getActive();
  return a && a.token0 && a.token1
    ? "9mm_price_override_" +
        a.token0.toLowerCase() +
        "_" +
        a.token1.toLowerCase() +
        "_" +
        (a.fee || 0)
    : null;
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

/** Save price overrides to pool-scoped localStorage. */
function _save(p0, p1) {
  const k = _overrideKey();
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
function _saveForce(v) {
  const k = _overrideKey();
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
  _save(p0, p1);
  _saveForce(force);
  const m = g("priceOverrideModal");
  if (m) m.classList.add("hidden");
  const active = posStore.getActive();
  if (!active) return;
  const pk = compositeKey(
    "pulsechain",
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({
      priceOverride0: p0,
      priceOverride1: p1,
      priceOverrideForce: force,
      positionKey: pk,
    }),
  }).catch(() => {});
  if (!isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
}

/** Close the price override dialog without saving. */
export function closePriceOverrideDialog() {
  const m = g("priceOverrideModal");
  if (m) m.classList.add("hidden");
}
