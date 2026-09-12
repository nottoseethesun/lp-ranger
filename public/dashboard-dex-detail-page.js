/**
 * @file dashboard-dex-detail-page.js
 * @description Paints the "Dex Detail Page" link that sits directly
 *   above Chart Links in the Pool Details dialog — the deep link to the
 *   DEX's own pair page (e.g.
 *   `https://dex.9mm.pro/info/v3/pulsechain/pairs/0x82db…`).
 *
 *   Everything except the pool address is resolved server-side by
 *   `src/dex-detail-page-url-generator.js` and arrives on the
 *   `/api/lp-providers` entry as `dexDetailPageUrlTemplate` (with
 *   `{poolId}` still in place) plus `dexDetailPageName` for the label.
 *   This module therefore does exactly what `paintChartLinks` does for
 *   the chart family: one `.replace("{poolId}", …)`, no knowledge of
 *   the chain, the DEX domain, or the NFT contract.
 *
 *   The link is per-provider, so it is looked up with the position's
 *   own position-manager address against the sticky factory context —
 *   a wallet holding LPs from two different v3 forks gets the right
 *   DEX for whichever position is on screen. A position whose provider
 *   configures no detail page simply hides the row.
 */

import { g } from "./dashboard-helpers.js";
import { getProviderFor } from "./dashboard-lp-providers.js";

/**
 * Resolve the label + href for a position, or `null` when this
 * provider has no detail page on the active chain.
 * @param {string|null|undefined} positionManager
 * @param {string|null|undefined} poolAddress
 * @returns {{ name: string, url: string } | null}
 */
function _resolve(positionManager, poolAddress) {
  const entry = getProviderFor(positionManager);
  if (entry === null || entry === undefined) return null;
  const { dexDetailPageName: name, dexDetailPageUrlTemplate: tpl } = entry;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof tpl !== "string" || !tpl.includes("{poolId}")) return null;
  const id = (poolAddress || "").toLowerCase();
  if (id.length === 0) return null;
  return { name, url: tpl.replace("{poolId}", id) };
}

/**
 * Populate (or hide) the Dex Detail Page row of the Pool Details
 * modal. Hidden rather than disabled when unavailable: unlike the
 * chart links — a fixed set where a greyed entry tells the user the
 * pool address hasn't loaded yet — this row's absence is a permanent
 * property of the provider, so showing a dead one would be noise.
 * @param {string|null|undefined} positionManager  NFT contract address.
 * @param {string|null|undefined} poolAddress
 */
export function paintDexDetailPage(positionManager, poolAddress) {
  const wrap = g("pdDexDetailWrap");
  const link = g("pdDexDetail");
  if (wrap === null || !(link instanceof HTMLAnchorElement)) return;

  const resolved = _resolve(positionManager, poolAddress);
  if (resolved === null) {
    link.href = "#";
    link.textContent = "";
    wrap.hidden = true;
    return;
  }
  link.href = resolved.url;
  link.textContent = resolved.name;
  wrap.hidden = false;
}
