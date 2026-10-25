/**
 * @file dashboard-price-override.js
 * @description Manual token price override for positions where
 *   auto-detection fails. The server keeps each position's override under
 *   its fully-qualified key (`POST /api/config`), and applies it there,
 *   to the bot's figures for a managed position and to the details of an
 *   unmanaged one, so it holds in any browser and after Clear Local
 *   Storage. The dialog opens with the override the server's last status
 *   answer carries under the key of the position on screen.
 */

import { g, truncName, compositeKey } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions-store.js";
import { _posContextHtml } from "./dashboard-data-status.js";
import { saveConfigValues } from "./dashboard-config-save.js";
import { activeChainId } from "./dashboard-chain.js";
import { getLastStatus } from "./dashboard-data.js";

let _refetchUnmanaged = null;
/** Inject re-fetch callback (avoids circular import). */
export function injectPriceOverrideDeps(deps) {
  if (deps.refetchUnmanaged) _refetchUnmanaged = deps.refetchUnmanaged;
}

/**
 * A position's fully-qualified key, the one the server keeps its
 * settings under. Null until the chain is known.
 * @param {object} active  posStore entry.
 * @returns {string|null}
 */
function _positionKey(active) {
  return compositeKey(
    activeChainId(),
    active.walletAddress,
    active.contractAddress,
    active.tokenId,
  );
}

/*-
 *  The prices the last details answer gave an unmanaged position, kept
 *  under that position's key so another position's never fill the
 *  dialog.
 */
let _lastPrices = { key: null, price0: 0, price1: 0 };

/**
 * Remember the prices a details answer gave, for the dialog to start
 * from when the position has no saved override.
 * @param {object} pos  posStore entry the answer is for.
 * @param {number} p0
 * @param {number} p1
 */
export function setLastPrices(pos, p0, p1) {
  _lastPrices = { key: _positionKey(pos), price0: p0, price1: p1 };
}

/**
 * The override the server keeps for a position, as its last status
 * answer carries it under the position's own key. A price of 0, or none,
 * is no override.
 * @param {string|null} key  The position's fully-qualified key.
 * @returns {{price0: number, price1: number, force: boolean}}
 */
function _savedOverride(key) {
  const st =
    key === null ? undefined : getLastStatus()?._allPositionStates?.[key];
  const price = (v) => (typeof v === "number" && v > 0 ? v : 0);
  return {
    price0: price(st?.priceOverride0),
    price1: price(st?.priceOverride1),
    force: st?.priceOverrideForce === true,
  };
}

/** Open the price override dialog, pre-populated with current prices. */
export function openPriceOverrideDialog() {
  const active = posStore.getActive();
  if (!active) return;
  const key = _positionKey(active);
  const ov = _savedOverride(key);
  const last =
    key !== null && _lastPrices.key === key
      ? _lastPrices
      : { price0: 0, price1: 0 };
  const i0 = g("priceOverrideInput0"),
    i1 = g("priceOverrideInput1");
  if (i0) i0.value = ov.price0 > 0 ? ov.price0 : last.price0 || "";
  if (i1) i1.value = ov.price1 > 0 ? ov.price1 : last.price1 || "";
  const l0 = g("priceOverrideLabel0"),
    l1 = g("priceOverrideLabel1");
  if (l0) l0.textContent = truncName(active.token0Symbol || "Token 0", 20);
  if (l1) l1.textContent = truncName(active.token1Symbol || "Token 1", 20);
  /*- Populate the pool-identity header so users always know which pool
   *  these prices apply to (provider, pair, fee tier, NFT, chain, wallet). */
  const ctx = g("priceOverrideCtx");
  if (ctx) ctx.innerHTML = _posContextHtml();
  const fc = g("priceOverrideForce");
  if (fc) fc.checked = ov.force;
  const m = g("priceOverrideModal");
  if (m) m.classList.remove("hidden");
}

/** Save prices from the dialog to the server, and refetch on its answer. */
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
  if (active === null || active === undefined) return;
  saveConfigValues({
    values: {
      priceOverride0: p0,
      priceOverride1: p1,
      priceOverrideForce: force,
    },
    positionKey: _positionKey(active),
    inputs: {
      priceOverride0: "priceOverrideInput0",
      priceOverride1: "priceOverrideInput1",
    },
    onSaved: (onScreen) => _afterPriceSaved({ active, onScreen }),
  });
}

/**
 * What a price override the server took does in the browser: an
 * unmanaged position's figures are asked for again, and the server
 * applies the saved prices to them. That is for the screen, so it waits
 * for the answer to be about the position on it. A managed position's
 * figures take the prices at the bot's next check.
 *
 * Exported so a test can drive it: the request goes through the global
 * `fetch`, which a test must not replace.
 *
 * @param {object} o
 * @param {object} o.active      The position saved for.
 * @param {boolean} o.onScreen   Whether it is still the one on screen.
 */
export function _afterPriceSaved({ active, onScreen }) {
  if (onScreen && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
}

/** Close the price override dialog without saving. */
export function closePriceOverrideDialog() {
  const m = g("priceOverrideModal");
  if (m) m.classList.add("hidden");
}
