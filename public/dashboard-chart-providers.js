/**
 * @file dashboard-chart-providers.js
 * @description Fetches the per-chain Chart Links list from
 *   `GET /api/chart-providers` (backed by `src/chart-providers.js` +
 *   `app-config/static-tunables/chains.json`) and exposes a small
 *   helper that resolves a pool address into clickable URLs for each
 *   provider. The blockchain slug is already substituted server-side
 *   so the client never hard-codes any chain identifier.
 *
 *   Each provider entry has shape `{ key, name, urlTemplate }`, where
 *   `urlTemplate` still contains the literal `{poolId}` placeholder.
 *   The pool address is lowercased before substitution to match how
 *   each chart site normalises the path segment.
 */

import { g } from "./dashboard-helpers.js";

/** In-memory cache populated once at init. */
let _providers = [];

/**
 * One-shot fetch of the chart-providers list. Fetch or parse failures
 * leave the cache empty so the Chart Links section simply renders
 * empty — never blocks the Pool Details modal from opening.
 * @returns {Promise<void>}
 */
export async function loadChartProviders() {
  try {
    const res = await fetch("/api/chart-providers");
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.providers)) return;
    /*- Defensive shape check — drop malformed entries rather than let
        a server bug crash the modal renderer. */
    _providers = data.providers.filter(
      (p) =>
        p &&
        typeof p.key === "string" &&
        typeof p.name === "string" &&
        typeof p.urlTemplate === "string" &&
        p.urlTemplate.includes("{poolId}"),
    );
    console.log("[chart-providers] loaded %d provider(s)", _providers.length);
  } catch (err) {
    console.warn("[chart-providers] fetch failed:", err && err.message);
  }
}

/**
 * Build the clickable URL for one provider against a given pool.
 * Returns `null` when the pool address is missing.
 * @param {{ urlTemplate: string }} provider
 * @param {string|null|undefined} poolAddress
 * @returns {string|null}
 */
function _buildUrl(provider, poolAddress) {
  const id = (poolAddress || "").toLowerCase();
  if (!id) return null;
  return provider.urlTemplate.replace("{poolId}", id);
}

/**
 * Populate the Chart Links section of the Pool Details modal for the
 * given pool address. Each anchor's `href` is set to the resolved URL;
 * when the pool address is missing, every link is disabled by removing
 * its `href` (so it renders as plain text rather than a broken link).
 * @param {string|null|undefined} poolAddress
 */
export function paintChartLinks(poolAddress) {
  for (const p of _providers) {
    const a = g(`pdChart_${p.key}`);
    if (!(a instanceof HTMLAnchorElement)) continue;
    const url = _buildUrl(p, poolAddress);
    if (url) {
      a.href = url;
      a.removeAttribute("aria-disabled");
    } else {
      /*- Keep the placeholder href so html-validate stays happy on
       *  static analysis, but mark the link disabled so CSS can grey
       *  it out and pointer-events: none stops it from navigating. */
      a.href = "#";
      a.setAttribute("aria-disabled", "true");
    }
  }
}
